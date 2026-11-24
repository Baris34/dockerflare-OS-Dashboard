import { setTimeout as delay } from "node:timers/promises";

const [panel = "http://127.0.0.1:4320", os = "http://127.0.0.1:8787"] = process.argv.slice(2);

async function get(base, path, service) {
  const url = new URL(path, base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Yerel bir HTTP adresi gir.");
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (response.ok) return await response.json();
  } catch { /* report which local process to check */ }
  throw new Error(service + " yanıt vermedi. Adres: " + url.origin);
}

async function check() {
  const events = () => get(panel, "/api/events?source=files&service=dockerflare-local.jsonl&q=GET%20%2Fapi%2Fversion%20%7C%20HTTP%20200&limit=1", "OS Dashboard");
  const before = (await events()).items[0]?.id ?? 0;
  const version = await get(os, "/api/version", "Dockerflare OS");
  if (!Object.hasOwn(version, "version")) throw new Error("Bu adres OS sürüm bilgisini döndürmedi.");
  for (let i = 0; i < 20; i++) {
    const row = (await events()).items[0];
    if (row && row.id > before) {
      console.log("OS Dashboard kaydı #" + row.id + " · " + row.message);
      const chats = await get(panel, "/api/workshop/chats?limit=1", "Workshop kaynağı");
      console.log(chats.connected ? "Workshop sohbet kaynağı bağlı." : "Workshop sohbet kaynağı bekleniyor.");
      return;
    }
    await delay(750);
  }
  throw new Error("OS yanıt verdi ama panelde yeni erişim kaydı yok. OS terminalinde local-os.mjs çalıştığını ve panelin aynı logs klasörünü izlediğini kontrol et.");
}

try {
  await check();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
