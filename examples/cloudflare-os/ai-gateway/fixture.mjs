import { createServer } from "node:http";

const role = process.argv[2];
if (role !== "model" && role !== "guard") throw new Error("Unknown fixture");
const counts = { total: 0, input: 0, output: 0, models: {} };
const send = (res, status, data) => res.writeHead(status, {
  "content-type": "application/json",
}).end(JSON.stringify(data));

function completion(res, model, content, stream) {
  const meta = { id: "demo-completion", model, created: Math.floor(Date.now() / 1000) };
  const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
  if (!stream) return send(res, 200, {
    ...meta, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
  const frame = (choices, extra = {}) => "data: " + JSON.stringify({
    ...meta, object: "chat.completion.chunk", choices, ...extra,
  }) + "\n\n";
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(frame([{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]));
  res.write(frame([{ index: 0, delta: {}, finish_reason: "stop" }]));
  res.end(frame([], { usage }) + "data: [DONE]\n\n");
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/counts") return send(res, 200, counts);
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(res, 404, {});
  try {
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return send(res, 413, {});
      parts.push(chunk);
    }
    const { model, messages, stream } = JSON.parse(Buffer.concat(parts));
    if (!Array.isArray(messages)) return send(res, 400, {});
    counts.total++;
    if (role === "guard") {
      if (model !== "fixture-guard") return send(res, 400, {});
      const output = messages.at(-1)?.role === "assistant";
      counts[output ? "output" : "input"]++;
      const unsafe = messages.some(m => ["DEMO_AMBER_INPUT", "DEMO_AMBER_REPLY"].some(
        marker => JSON.stringify(m.content).includes(marker),
      ));
      const verdict = ["Safety: " + (unsafe ? "Unsafe" : "Safe"),
        "Categories: " + (unsafe ? "Violent" : "None")];
      if (output) verdict.push("Refusal: No");
      return completion(res, model, verdict.join("\n"), false);
    }
    if (!["demo-pass", "demo-dlp", "demo-guard-in", "demo-guard-out"].includes(model))
      return send(res, 400, {});
    counts.models[model] = (counts.models[model] || 0) + 1;
    const content = model === "demo-guard-out" ? "DEMO_AMBER_REPLY" : "Demo yanıtı tamamlandı.";
    completion(res, model, content, stream);
  } catch {
    send(res, 400, { error: "Fixture request failed" });
  }
}).listen(8000);
