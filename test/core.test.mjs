import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

test("Seyir records usage, streamed usage, policy blocks and searchable file logs across restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "seyir-test-"));
  const messages = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const data = JSON.parse(raw);
    messages.push(data);
    if (data.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"model":"actual","choices":[{"delta":{"content":"ok"}}]}\n\n',
      );
      res.end(
        'data: {"model":"actual","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "actual",
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 6, completion_tokens: 2 },
        }),
      );
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await new Promise((r) => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const { start } = await import("../server.mjs");
  app = await start({ dir, port: 0, collect: false });
  const post = (path, data, headers = {}) =>
    fetch(app.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  const ask = (message, stream = false) =>
    post(
      "/v1/chat/completions",
      {
        model: "asked",
        messages: [{ role: "user", content: message }],
        stream,
      },
      { "x-seyir-trace": "test-turn" },
    );
  assert.equal((await ask("no upstream yet")).status, 503);
  const base = "http://127.0.0.1:" + upstream.address().port + "/v1";
  assert.equal(
    (
      await post(
        "/api/settings",
        { upstream: base, dlp: true, rate: 0 },
        { origin: "https://example.net" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/settings", { upstream: base, dlp: true, rate: 0 }))
      .status,
    200,
  );
  assert.equal(
    (await (await ask("test message never persist")).json()).choices[0].message
      .content,
    "answer",
  );
  assert.match(await (await ask("stream", true)).text(), /\[DONE\]/);
  assert.equal((await ask("synthetic 4111 1111 1111 1111")).status, 424);
  assert.equal(messages.length, 2);
  const json = (path) => fetch(app.url + path).then((r) => r.json());
  let list = (await json("/api/events?source=gateway")).items;
  assert.equal(list.length, 4);
  assert.equal(
    list.filter((e) => e.trace_id === "test-turn" && e.level === "info").length,
    2,
  );
  assert.deepEqual(
    list
      .filter((e) => e.level === "info")
      .map((e) => e.output_tokens)
      .sort(),
    [2, 3],
  );
  assert.ok(list.some((e) => e.served_model === "actual"));
  assert.doesNotMatch(
    JSON.stringify(list),
    /test message never persist|4111 1111|choices/,
  );
  const log = join(dir, "logs", "sample.log");
  await writeFile(log, "INFO first line\n");
  await app.collectFiles();
  await appendFile(log, "ERROR disk simulation api_key=never-print-this\n");
  await app.collectFiles();
  await app.collectFiles();
  let found = (await json("/api/events?q=disk%20simulation")).items;
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "error");
  assert.doesNotMatch(found[0].message, /never-print-this/);
  await app.close();
  app = await start({ dir, port: 0, collect: false });
  await app.collectFiles();
  found = (await json("/api/events?q=disk%20simulation")).items;
  assert.equal(found.length, 1);
  assert.equal((await json("/api/settings")).upstream, base);
});
