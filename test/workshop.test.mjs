import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import http from "node:http";
import { start } from "../server.mjs";

const workspace = "a".repeat(64);
test("chat audit uses exact gateway response IDs, bills every guard call, and preserves unknown historical prices", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "seyir-chat-"));
  const file = join(dir, "projection.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(`CREATE TABLE chat(workspace_id,chat_id INTEGER,started_at,updated_at,initiator);
    CREATE TABLE chat_event(workspace_id,chat_id INTEGER,event_id,type,ts,name,actor,status,
      cost_usd,cost_source,request_id,operation,http_status,served_model,requested_model,input_tokens,output_tokens,private_message);
  `);
  for (const [key, chat, person] of [
    [workspace, 0, "starter"],
    ["b".repeat(64), 0, "someone-else"],
  ]) {
    db.prepare("INSERT INTO chat VALUES(?,?,1,2,?)").run(key, chat, person);
  }
  const api = await start({ dir, port: 0, collect: false, workshopFile: file });
  t.after(() => api.close());
  const models = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts));
    const guard = body.model === "guard";
    const output = body.messages.at(-1).role === "assistant";
    const content = guard
      ? "Safety: Safe\nCategories: None" + (output ? "\nRefusal: No" : "")
      : "ok";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          { message: { role: "assistant", content }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
  });
  models.listen(0, "127.0.0.1");
  await once(models, "listening");
  t.after(() => new Promise((done) => models.close(done)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = "http://127.0.0.1:" + models.address().port;
  const settings = await fetch(api.url + "/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      upstream: root,
      guardRoot: root,
      guardModel: "guard",
      prices: ["main", "guard"].map((model) => ({
        model,
        input: 1,
        cached: 0,
        output: 2,
      })),
    }),
  });
  assert.equal(settings.status, 200);
  const reply = await fetch(api.url + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-seyir-accounting": "workshop",
    },
    body: JSON.stringify({
      model: "main",
      messages: [{ role: "user", content: "example" }],
    }),
  });
  assert.equal(reply.status, 200);
  await reply.text();
  const request = reply.headers.get("x-seyir-request-id");
  assert.ok(request);
  const add = db.prepare(
    "INSERT INTO chat_event(workspace_id,chat_id,event_id,type,ts,name,actor,status,request_id,private_message) VALUES(?,0,?,?,1,?,?,?,?,?)",
  );
  add.run(
    workspace,
    "model:1",
    "model",
    "main",
    "starter",
    "completed",
    request,
    "NEVER_EXPORT",
  );
  add.run(
    workspace,
    "approval:1",
    "approval",
    "tool",
    "reviewer",
    "approved",
    null,
    "NEVER_EXPORT",
  );
  const chatURL =
    api.url + "/api/workshop/chat?workspace_id=" + workspace + "&chat_id=0";
  const chat = await (await fetch(chatURL)).json();
  assert.equal(chat.initiator, "starter");
  assert.equal(
    chat.events.find((e) => e.type === "approval").actor,
    "reviewer",
  );
  assert.equal(chat.events.filter((e) => e.type === "guard").length, 2);
  assert.equal(chat.priced, 3);
  assert.ok(chat.cost_complete);
  assert.ok(Math.abs(chat.cost_usd - 42e-6) < 1e-12);
  assert.ok(!JSON.stringify(chat).includes("NEVER_EXPORT"));
  add.run(
    workspace,
    "legacy:1",
    "model",
    "legacy",
    "starter",
    "completed",
    null,
    null,
  );
  const partial = await (await fetch(chatURL)).json();
  assert.equal(partial.unpriced, 1);
  assert.equal(partial.cost_complete, false);
  assert.equal(partial.cost_usd, chat.cost_usd);
  const other = await (
    await fetch(chatURL.replace(workspace, "b".repeat(64)))
  ).json();
  assert.equal(other.events.length, 0);
  assert.equal(other.cost_usd, null);
  assert.equal((await fetch(chatURL.replace(workspace, "../"))).status, 400);
  assert.equal(
    (await fetch(chatURL.replace("chat_id=0", "chat_id=99"))).status,
    404,
  );
});
