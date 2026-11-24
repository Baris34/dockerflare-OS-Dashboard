import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeGateway } from "../lib/gateway.mjs";

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}
const chat = (content) => ({
  model: "local",
  messages: [{ role: "user", content }],
});
const reply = (content) => ({
  choices: [{ message: { role: "assistant", content } }],
});
function send(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function setup(t) {
  const records = [],
    guardCalls = [],
    upstreamCalls = [];
  const cfg = { dlp: true, guardAction: "block" };
  const service = {
    respond: (res) => send(res, reply("public answer")),
    classify: (last) =>
      "Safety: Safe\nCategories: None" +
      (last.role === "assistant" ? "\nRefusal: No" : ""),
  };
  async function body(req) {
    let raw = "";
    for await (const c of req) raw += c;
    return JSON.parse(raw);
  }
  cfg.guardRoot =
    (await listen(t, async (req, res) => {
      const data = await body(req);
      guardCalls.push({ data, headers: req.headers });
      send(res, reply(service.classify(data.messages.at(-1))));
    })) + "/v1";
  cfg.upstream =
    (await listen(t, async (req, res) => {
      upstreamCalls.push(await body(req));
      service.respond(res);
    })) + "/v1";
  const proxy = makeGateway(
    {
      record(e) {
        records.push(e);
      },
    },
    () => cfg,
  );
  const url = await listen(t, (req, res) => proxy(req, res, req.url));
  const post = (data, path = "/v1/chat/completions") =>
    fetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seyir-trace": "case-1",
      },
      body: JSON.stringify(data),
    });
  return { cfg, records, guardCalls, upstreamCalls, service, post, url };
}
test("ordinary route classifies both turns, retaining prior conversation and interrupting unsafe output", async (t) => {
  const { records, guardCalls, upstreamCalls, service, post } = await setup(t);
  service.classify = (m) =>
    m.role === "assistant"
      ? "Safety: Unsafe\nCategories: PII\nRefusal: No"
      : "Safety: Safe\nCategories: None";
  const data = chat("context-one");
  data.messages.push(
    { role: "assistant", content: "prior answer" },
    { role: "user", content: "new turn" },
  );
  const response = await post(data);
  assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /public answer/);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(guardCalls.length, 2);
  assert.deepEqual(guardCalls[0].data.messages, data.messages);
  assert.deepEqual(guardCalls[1].data.messages, [
    ...data.messages,
    { role: "assistant", content: "public answer" },
  ]);
  const decisions = records.filter((e) => e.source === "policy");
  assert.deepEqual(
    decisions.map((e) => [e.operation, e.kind]),
    [
      ["input", "allow"],
      ["input", "allow"],
      ["output", "allow"],
      ["output", "block"],
    ],
  );
  assert.ok(
    decisions.every(
      (e) =>
        e.trace_id === "case-1" && e.request_id === records.at(-1).request_id,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(records),
    /context-one|prior answer|new turn|public answer/,
  );
});
test("input DLP blocks credentials before an unconfigured upstream and before external classification", async (t) => {
  const { cfg, post, records, guardCalls } = await setup(t);
  cfg.upstream = "";
  const sensitive = "sk-proj-" + "A".repeat(40);
  assert.equal((await post(chat(sensitive))).status, 424);
  assert.equal(guardCalls.length, 0);
  assert.ok(
    records.some(
      (e) =>
        e.source === "policy" &&
        e.kind === "block" &&
        e.operation === "input" &&
        e.service === "DLP",
    ),
  );
  assert.ok(!JSON.stringify(records).includes(sensitive));
});
test("buffered tool arguments split across SSE chunks receive a single output decision before release", async (t) => {
  const { service, post, guardCalls } = await setup(t);
  service.classify = (m) =>
    m.role === "assistant" && m.content.includes("PRIVATE_TOOL_VALUE")
      ? "Safety: Unsafe\nCategories: PII\nRefusal: No"
      : "Safety: Safe\nCategories: None";
  service.respond = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [i, part] of ['{"text":"PRIVATE_', 'TOOL_VALUE"}'].entries()) {
      const fn =
        i === 0 ? { name: "lookup", arguments: part } : { arguments: part };
      res.write(
        "data: " +
          JSON.stringify({
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: fn }] } },
            ],
          }) +
          "\n\n",
      );
    }
    res.end("data: [DONE]\n\n");
  };
  const response = await post({ ...chat("tooltest"), stream: true });
  assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /PRIVATE_|data:/);
  assert.match(
    guardCalls.at(-1).data.messages.at(-1).content,
    /PRIVATE_TOOL_VALUE/,
  );
});
test("policy rejects uninspectable media, malformed guard text, self-reference and unknown provider frames", async (t) => {
  const { cfg, post, guardCalls, upstreamCalls, records, service, url } =
    await setup(t);
  const media = await post(
    chat([{ type: "image_url", image_url: { url: "data:image/png,fixture" } }]),
  );
  assert.ok(media.status >= 400);
  assert.equal(upstreamCalls.length, 0);
  service.classify = () => "Safety: Safe\nCategories: None\nraw-extra-marker";
  assert.ok((await post(chat("input"))).status >= 400);
  assert.equal(upstreamCalls.length, 0);
  cfg.guardRoot = url + "/v1";
  const before = guardCalls.length;
  assert.ok((await post(chat("self"))).status >= 400);
  assert.equal(guardCalls.length, before);
  cfg.guardRoot = "";
  service.respond = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"type":"unknown","delta":"raw-extra-marker"}\n\ndata: [DONE]\n\n',
    );
  };
  const response = await post({ ...chat("unknown"), stream: true });
  assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /raw-extra-marker/);
  assert.doesNotMatch(JSON.stringify(records), /raw-extra-marker/);
});
test("Responses output and tool inputs use assistant and user guard modes, controversial verdicts flag", async (t) => {
  const { service, post, guardCalls, records } = await setup(t);
  const item = {
    type: "function_call",
    name: "get",
    call_id: "t1",
    arguments: '{"key":"public"}',
  };
  service.respond = (res) => send(res, { output: [item], status: "completed" });
  service.classify = (m) =>
    m.role === "assistant"
      ? "Safety: Controversial\nCategories: Unethical Acts\nRefusal: No"
      : "Safety: Safe\nCategories: None";
  const response = await post(
    {
      model: "local",
      input: [
        { role: "user", content: "history" },
        item,
        { type: "function_call_output", call_id: "t1", output: "tool-output" },
      ],
    },
    "/v1/responses",
  );
  assert.equal(response.status, 200);
  assert.equal(guardCalls.length, 2);
  assert.match(guardCalls[0].data.messages.at(-1).content, /tool-output/);
  assert.match(guardCalls[1].data.messages.at(-1).content, /public/);
  assert.equal(
    records.filter((e) => e.kind === "flag" && e.operation === "output").length,
    1,
  );
});

test("guard keys are scoped to their exact origin and input rate limits precede guard calls", async (t) => {
  const { cfg, post, guardCalls, upstreamCalls, service } = await setup(t);
  const saved = {
    key: process.env.SEYIR_GUARD_KEY,
    origin: process.env.SEYIR_GUARD_KEY_ORIGIN,
  };
  t.after(() => {
    for (const [name, value] of [
      ["SEYIR_GUARD_KEY", saved.key],
      ["SEYIR_GUARD_KEY_ORIGIN", saved.origin],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.SEYIR_GUARD_KEY = "local-fixture-only";
  process.env.SEYIR_GUARD_KEY_ORIGIN = "https://different.invalid";
  cfg.guardAction = "flag";
  cfg.rate = 2;
  service.classify = (last) =>
    "Safety: Unsafe\nCategories: PII" +
    (last.role === "assistant" ? "\nRefusal: No" : "");
  assert.equal((await post(chat("first"))).status, 200);
  assert.equal(guardCalls[0].headers.authorization, undefined);
  process.env.SEYIR_GUARD_KEY_ORIGIN = new URL(cfg.guardRoot).origin;
  assert.equal((await post(chat("second"))).status, 200);
  assert.equal(
    guardCalls[2].headers.authorization,
    "Bearer local-fixture-only",
  );
  assert.equal((await post(chat("third"))).status, 429);
  assert.equal(guardCalls.length, 4);
  assert.equal(upstreamCalls.length, 2);
});

test("Responses SSE reconstructs deltas even when the final snapshot is different", async (t) => {
  const { cfg, service, post, records } = await setup(t);
  cfg.guardRoot = "";
  service.respond = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "4111 1111 ",
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "1111 1111",
      },
      {
        type: "response.completed",
        response: {
          model: "provider",
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 9 },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "public" }],
            },
          ],
        },
      },
    ];
    for (const frame of frames)
      res.write(
        "event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n",
      );
    res.end();
  };
  const response = await post(
    { model: "requested", input: "hello", stream: true },
    "/v1/responses",
  );
  assert.equal(response.status, 424);
  assert.doesNotMatch(await response.text(), /4111|data:/);
  const parent = records.find((e) => e.source === "gateway");
  assert.equal(parent.upstream_called, 1);
  assert.equal(parent.output_tokens, 9);
  assert.equal(parent.served_model, "provider");
});

test("oversized output, incomplete streams and provider error bodies fail closed", async (t) => {
  const { service, post } = await setup(t);
  const privateText = "private-provider-text";
  for (const respond of [
    (res) => send(res, reply(privateText.repeat(220000))),
    (res) =>
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          'data: {"choices":[{"delta":{"content":"private-provider-text"}}]}\n\n',
        ),
    (res) =>
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: privateText })),
    (res) =>
      res.writeHead(200, { "content-type": "image/png" }).end(privateText),
  ]) {
    service.respond = respond;
    const response = await post(chat("limit"));
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /private-provider-text/);
  }
});

test(
  "closing the client aborts a pending guard call before contacting the model",
  { timeout: 4000 },
  async (t) => {
    const { cfg, upstreamCalls, url } = await setup(t);
    const entered = Promise.withResolvers(),
      closed = Promise.withResolvers();
    cfg.guardRoot =
      (await listen(t, (req, res) => {
        res.once("close", closed.resolve);
        req.resume();
        entered.resolve();
      })) + "/v1";
    const controller = new AbortController();
    const pending = fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chat("pending")),
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    assert.equal(upstreamCalls.length, 0);
  },
);
