import http from "node:http";
import os from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStore, clean } from "./lib/store.mjs";
import { sources } from "./lib/sources.mjs";
import { workshopReader } from "./lib/workshop.mjs";
import { makeAiGateway, readJson, json, validateRoot } from "./lib/ai-gateway.mjs";
import { readSettings, mergeSettings } from "./lib/settings.mjs";
import {
  createInferenceListener,
  isInferenceRoute,
  loadClientToken,
  listen,
} from "./lib/inference-listener.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const staticFiles = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.css", ["app.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/icons.js", ["icons.js", "text/javascript"]],
  ["/mark.svg", ["mark.svg", "image/svg+xml"]],
]);
export async function start(options = {}) {
  const panelOnly = options.panelOnly ?? process.env.OS_DASHBOARD_PANEL_ONLY === "1";
  const workshopUrl = validateRoot(options.workshopUrl ?? process.env.DOCKERFLARE_WORKSHOP_URL) || null;
  const publicAiGatewayUrl =
    validateRoot(
      options.publicAiGatewayUrl ??
        process.env.OS_DASHBOARD_PUBLIC_AI_GATEWAY_URL ??
        (panelOnly ? "http://localhost:4322/v1" : ""),
    ) || null;
  const customDir = options.dir || process.env.OS_DASHBOARD_DATA_DIR;
  const dir = resolve(customDir || join(root, "data", "current"));
  const logs = resolve(
    process.env.OS_DASHBOARD_LOG_DIR || join(customDir || join(root, "data"), "logs"),
  );
  await mkdir(dir, { recursive: true });
  await mkdir(logs, { recursive: true });
  const store = openStore(join(dir, "os-dashboard.sqlite"));
  const workshop = workshopReader(store, options.workshopFile ?? process.env.OS_DASHBOARD_WORKSHOP_DB,
    options.demoDir ?? process.env.OS_DASHBOARD_WORKSHOP_DEMO_DIR);
  const src = sources(store, dir, { logs });
  const getSettings = () => readSettings(store);
  const proxy = panelOnly ? null : makeAiGateway(store, getSettings);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      let authority;
      try {
        authority = new URL("http://" + req.headers.host);
      } catch {
        return json(res, 403, { error: "Geçersiz host." });
      }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname))
        return json(res, 403, { error: "Yerel adres gerekli." });
      const origin = req.headers.origin;
      if (origin && origin !== "http://" + authority.host)
        return json(res, 403, { error: "Yabancı origin kabul edilmedi." });
      if (req.headers["sec-fetch-site"] === "cross-site")
        return json(res, 403, { error: "Siteler arası erişim kapalı." });
      if (
        req.method === "POST" &&
        !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
      )
        return json(res, 415, { error: "application/json gerekli." });
      if (req.method === "GET" && staticFiles.has(u.pathname)) {
        const [file, type] = staticFiles.get(u.pathname);
        const bytes = await readFile(join(root, "public", file));
        res.writeHead(200, {
          "content-type": type + "; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-cache",
          "content-security-policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        return res.end(bytes);
      }
      if (proxy && isInferenceRoute(req.method, u.pathname))
        return await proxy(req, res, u.pathname);
      if (req.method === "GET" && u.pathname === "/api/health")
        return json(res, 200, { ok: true });
      if (req.method === "GET" && ["/api/workshop/chats", "/api/workshop/chat"].includes(u.pathname)) {
        try {
          return json(res, 200, u.pathname.endsWith("/chats") ? workshop.list(u.searchParams) : workshop.detail(u.searchParams));
        } catch (error) {
          return json(res, error.status || 503, { error: error.status ? error.message : "Workshop kayıtları henüz okunamıyor." });
        }
      }
      if (req.method === "GET" && u.pathname === "/api/events")
        return json(res, 200, store.events(u.searchParams));
      if (req.method === "GET" && u.pathname === "/api/settings")
        return json(res, 200, getSettings());
      if (req.method === "POST" && u.pathname === "/api/settings") {
        const patch = await readJson(req, 32768);
        let updated;
        try {
          updated = mergeSettings(getSettings(), patch);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        store.batch(() => {
          store.put("settings", updated);
          store.record({
            source: "os-dashboard",
            service: "OS Dashboard",
            kind: "config",
            message: "AI Gateway ayarları güncellendi.",
          });
        });
        return json(res, 200, getSettings());
      }
      if (req.method === "POST" && u.pathname === "/api/events") {
        const evt = await readJson(req, 16384);
        if (
          !evt ||
          typeof evt.message !== "string" ||
          !evt.message.trim() ||
          typeof evt.service !== "string" ||
          !evt.service.trim()
        )
          return json(res, 400, { error: "service ve message gerekli." });
        const id = store.record({
          source: "ingest",
          service: clean(evt.service, 100),
          message: evt.message,
          level: evt.level,
          kind: clean(evt.kind || "log", 80),
          trace_id: evt.trace_id ? clean(evt.trace_id, 120) : null,
        });
        return json(res, 201, { id });
      }
      if (req.method === "GET" && u.pathname === "/api/overview") {
        const now = Date.now(),
          allowed = [900, 3600, 21600, 86400];
        const range = Number(u.searchParams.get("range")),
          seconds = allowed.includes(range) ? range : 3600;
        const cfg = getSettings();
        return json(res, 200, {
          now,
          range: seconds,
          ...store.summary(now - seconds * 1000),
          host: src.host(),
          sources: {
            ...src.status,
            "ai-gateway": {
              name: "AI Gateway",
              state: cfg.upstream ? "ready" : "off",
              note: cfg.upstream
                ? "Yapılandırıldı · " + new URL(cfg.upstream).host
                : "Endpoint bekleniyor.",
            },
          },
          settings: cfg,
          publicAiGatewayUrl,
          workshopUrl,
          guardKeyReady: panelOnly
            ? null
            : Boolean(
                process.env.OS_DASHBOARD_GUARD_KEY &&
                  cfg.guardRoot &&
                  new URL(cfg.guardRoot).origin ===
                    process.env.OS_DASHBOARD_GUARD_KEY_ORIGIN,
              ),
          keyReady: panelOnly
            ? null
            : !!process.env.OS_DASHBOARD_UPSTREAM_KEY &&
              !!cfg.upstream &&
              new URL(cfg.upstream).origin ===
                (process.env.OS_DASHBOARD_KEY_ORIGIN || "https://api.openai.com"),
        });
      }
      json(res, 404, { error: "Bulunamadı." });
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 500, {
          error: e.status ? e.message : "İşlem tamamlanamadı.",
        });
      else res.destroy();
    }
  });
  const port = options.port ?? Number(process.env.PORT || 4320),
    host = options.host || process.env.OS_DASHBOARD_BIND || "127.0.0.1";
  const ingress =
    !panelOnly &&
    (options.inference ||
      (process.env.OS_DASHBOARD_INFERENCE_BIND && {
        host: process.env.OS_DASHBOARD_INFERENCE_BIND,
        port: Number(process.env.OS_DASHBOARD_INFERENCE_PORT || 4322),
      }));
  let inference;
  try {
    if (ingress)
      inference = createInferenceListener(
        proxy,
        ingress.token ?? (await loadClientToken()),
      );
    await listen(server, port, host);
    if (inference) await listen(inference, ingress.port, ingress.host);
  } catch (error) {
    if (server.listening) await new Promise((done) => server.close(done));
    store.close();
    throw error;
  }
  store.prune();
  store.record({
    source: "os-dashboard",
    service: "OS Dashboard",
    level: "info",
    kind: "startup",
    message: "Gözlem servisi başlatıldı.",
    detail: os.platform() + " · " + os.arch(),
  });
  const prune = setInterval(() => store.prune(), 3600000);
  prune.unref();
  if (options.collect !== false) src.start();
  const close = async () => {
    clearInterval(prune);
    await Promise.all(
      [server, inference]
        .filter(Boolean)
        .map((s) => new Promise((r) => s.close(r))),
    );
    await src.stop();
    store.close();
  };
  return {
    url: "http://127.0.0.1:" + server.address().port,
    inferenceUrl: inference
      ? "http://127.0.0.1:" + inference.address().port
      : null,
    close,
    collectFiles: src.files,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await start();
  console.log("OS Dashboard " + app.url);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
