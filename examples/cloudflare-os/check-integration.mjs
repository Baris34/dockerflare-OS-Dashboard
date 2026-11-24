import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const [panel = "http://127.0.0.1:4321", web = "http://127.0.0.1:18080"] = process.argv.slice(2);
async function get(base, path) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path + " yanıt vermedi.");
  return response;
}

const chats = await (await get(panel, "/api/workshop/chats?limit=1")).json();
assert.equal(chats.connected, true, "Workshop sohbet kaynağı bağlı değil.");
const overview = await (await get(panel, "/api/overview")).json();
assert.ok(overview.workshopUrl, "DOCKERFLARE_WORKSHOP_URL ayarlanmalı.");
const response = await get(web, "/api/version");
const trace = response.headers.get("x-seyir-trace");
assert.match(trace || "", /^[a-f0-9]{32}$/, "Dockerflare Web iz kimliği döndürmedi.");
for (let attempt = 0; ; attempt++) {
  const events = await (await get(panel, "/api/events?trace_id=" + trace)).json();
  if (events.items.some((e) => e.trace_id === trace && e.source === "files" && e.message.includes("GET /api/version | HTTP 200"))) break;
  assert.ok(attempt < 20, "Web isteğinin erişim kaydı panelde bulunamadı.");
  await delay(1000);
}
console.log("Workshop kaynağı bağlı. Dockerflare Web isteği OS Dashboard’da doğrulandı.");
console.log(new URL("/#gateway?trace=" + trace, panel).href);
