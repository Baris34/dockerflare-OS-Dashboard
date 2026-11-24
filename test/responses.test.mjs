import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../server.mjs";

test("Responses and SSE retain actual model, logical source and historical tariff", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "seyir-responses-"));
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    input_tokens_details: { cached_tokens: 200 },
  };
  const up = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const response = {
      id: "r1",
      model: "test-model",
      usage,
      status: "completed",
    };
    if (JSON.parse(raw).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "event: response.completed\ndata: " +
          JSON.stringify({ type: "response.completed", response }) +
          "\n\n",
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    }
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const app = await start({ dir, port: 0, collect: false });
  t.after(async () => {
    await app.close();
    await new Promise((r) => up.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const post = (path, body, extra = {}) =>
    fetch(app.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  const settings = {
    upstream: "http://127.0.0.1:" + up.address().port + "/v1",
    dlp: false,
    rate: 0,
    prices: [{ model: "test-model", input: 2, cached: 1, output: 8 }],
  };
  assert.equal((await post("/api/settings", settings)).status, 200);
  for (const stream of [false, true]) {
    const res = await post(
      "/v1/responses",
      { model: "alias", input: "private fixture", stream },
      { "x-seyir-trace": "conversation-one", "x-seyir-source": "thread-title" },
    );
    assert.equal(res.status, 200);
    await res.text();
  }
  assert.equal(
    (await post("/api/settings", { ...settings, prices: [] })).status,
    200,
  );
  await post("/api/events", {
    service: "worker",
    message: "İş tamamlandı",
    trace_id: "conversation-one",
  });
  const timeline = await (
    await fetch(
      app.url + "/api/events?trace_id=conversation-one&source=gateway&limit=1",
    )
  ).json();
  assert.equal(timeline.trace.events, 3);
  assert.equal(timeline.trace.requests, 2);
  assert.equal(timeline.trace.priced, 2);
  assert.ok(Math.abs(timeline.trace.cost_usd - 0.0116) < 0.0000001);
  const rows = (
    await (
      await fetch(
        app.url + "/api/events?trace_id=conversation-one&source=gateway",
      )
    ).json()
  ).items;
  assert.equal(rows.length, 2);
  for (const e of rows) {
    assert.equal(e.level, "info");
    assert.equal(e.operation, "thread-title");
    assert.equal(e.served_model, "test-model");
    assert.equal(e.cached_tokens, 200);
    assert.ok(Math.abs(e.cost_usd - 0.0058) < 0.0000001);
  }
  const snap = await (await fetch(app.url + "/api/overview")).json();
  assert.equal(snap.stats.priced, 2);
  assert.ok(Math.abs(snap.stats.cost_usd - 0.0116) < 0.0000001);
  assert.doesNotMatch(JSON.stringify(rows), /private fixture/);
});
