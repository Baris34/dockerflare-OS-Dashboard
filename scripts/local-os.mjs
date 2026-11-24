import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { panelPaths } from "../lib/paths.mjs";

// Wrangler's access log contains paths that can carry connection tickets.
// Persist only known route classes and the numeric HTTP status.
export function localAccessEvent(line) {
  const match = /^\s*\[wrangler(?:-UserWorker)?:info\]\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s+([1-5]\d{2})\b/.exec(stripVTControlCharacters(line));
  if (!match) return null;
  const [, method, rawPath, code] = match;
  const path = rawPath.split(/[?#]/, 1)[0];
  const group = /^\/(api|gatekeeper|blueprint-screenshot)(?:\/|$)/.exec(path);
  const route = ["/", "/api/version", "/healthz"].includes(path) ? path : group && "/" + group[1];
  if (!route) return null;
  return {
    level: code[0] === "5" ? "error" : code[0] === "4" ? "warn" : "info",
    message: method + " " + route + " | HTTP " + code,
  };
}

async function followWorkshop(osDir, outputFile) {
  const exporter = join(osDir, "docker", "os-dashboard-export", "export.mjs");
  if (!existsSync(exporter)) {
    console.error("Workshop sohbetleri için Dockerflare OS deposundaki docker/os-dashboard-export gerekli. HTTP kaydı açık.");
    return () => {};
  }
  const { openProjection } = await import(pathToFileURL(exporter).href);
  const objectsDir = resolve(process.env.OS_DASHBOARD_WORKSHOP_OBJECTS || join(osDir, ".wrangler", "state", "v3", "do"));
  let projection, previous;
  function refresh() {
    let status;
    try {
      if (!existsSync(join(objectsDir, "workshop-backend-OverseerDurableObject"))) {
        status = "Workshop yerel veri dizini bekleniyor.";
      } else {
        projection ??= openProjection({ objectsDir, outputFile });
        status = projection.refresh().failed ? "Bazı Workshop kayıtları okunamadı, tekrar denenecek." : "Workshop sohbet kaynağı bağlı.";
      }
    } catch {
      status = "Workshop kayıtları okunamadı, tekrar denenecek.";
    }
    if (status !== previous) console.error(status);
    previous = status;
  }
  refresh();
  const timer = setInterval(refresh, 4000);
  timer.unref();
  return () => {
    clearInterval(timer);
    projection?.close();
  };
}

async function collect() {
  const osDir = process.cwd();
  if (!existsSync(join(osDir, "scripts", "run-local.ts"))) {
    throw new Error("Komutu OS deposunun kök klasöründen çalıştır.");
  }
  const { logs, nativeWorkshop } = panelPaths();
  await mkdir(logs, { recursive: true });
  const logPath = join(logs, "dockerflare-local.jsonl");
  const file = await open(logPath, "a", 0o600);
  let stop;
  try {
    try {
      stop = await followWorkshop(osDir, nativeWorkshop);
    } catch {
      console.error("Workshop aktarım aracı yüklenemedi. HTTP kaydı açık.");
    }
    console.error("OS Dashboard HTTP kayıt dosyası:", logPath);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const event = localAccessEvent(line);
      if (event) await file.appendFile(JSON.stringify(event) + "\n");
      if (!process.stdout.write(line + "\n")) await once(process.stdout, "drain");
    }
  } finally {
    stop?.();
    await file.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await collect();
