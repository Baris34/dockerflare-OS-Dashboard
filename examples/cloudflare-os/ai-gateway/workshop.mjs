import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { webSocketConnection } from "/src/packages/api-cli/src/session.ts";

const origin = "http://web:8080";
const modelRoot = "http://gateway:8000/v1";
for (let attempt = 0; ; attempt++) {
  let ready = false;
  try {
    const reply = await fetch(origin + "/api/version", { signal: AbortSignal.timeout(2000) });
    ready = reply.ok && Object.hasOwn(await reply.json(), "version");
  } catch { /* workerd is still starting */ }
  if (ready) break;
  if (attempt >= 89) throw new Error("Workshop zamanında açılamadı");
  await delay(1000);
}

using session = webSocketConnection("ws://web:8080/api", { Origin: origin }).main;
// This one-use private deployment only needs an unpredictable 32-byte verifier.
const token = await session.createAccount("seyirdemo", "OS Dashboard demo", randomBytes(32));
using api = await session.authenticate(token);
assert.equal(await api.amIAdmin(), true);
using ws = await api.newWorkspace();
const apiToken = readFileSync("/auth/token", "utf8");
const results = [];
const scenarios = [
  ["demo-pass", "Gökyüzünün rengini bir kelimeyle söyle.", "message"],
  ["demo-dlp", "Örnek test kartı " + Array(4).fill("4242").join(" "), "error"],
  ["demo-guard-in", "Bu örnekte DEMO_AMBER_INPUT işaretini kullan.", "error"],
  ["demo-guard-out", "Bu örnekte bir renk adı ver.", "error"],
];
for (const [model, text, expected] of scenarios) {
  await api.addModel({ type: "agent", id: model, name: model }, {
    provider: "openai-compatible", model, apiUrl: modelRoot, apiToken,
  });
  const chat = await ws.newChat(text, model);
  const result = await ws.waitForAgent(chat);
  assert.equal(result?.type, expected, model + " Workshop sonucu");
  if (expected === "message") assert.equal(result.message, "Demo yanıtı tamamlandı.");
  results.push({ model, chat, result: result.type });
}
console.log(JSON.stringify(results));
