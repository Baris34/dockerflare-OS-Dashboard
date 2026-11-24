import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { clean, usageCost } from "./store.mjs";
import {
  PolicyError,
  requestPolicy,
  policyInput,
  policyOutput,
  auditIdentifier,
} from "./policy.mjs";

export function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
export async function readJson(req, max = 4 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max)
      throw Object.assign(new Error("İstek boyutu sınırı aşıldı."), {
        status: 413,
      });
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Geçerli JSON gerekli."), { status: 400 });
  }
}
export function validateRoot(value) {
  if (!value) return "";
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error("Geçerli bir API kök adresi girin.");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("API kökü yalnız protokol, sunucu ve yol içerebilir.");
  return u.href.replace(/\/+$/, "");
}
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export function makeAiGateway(store, getSettings) {
  let recent = [];
  return async function proxy(req, res, path) {
    const started = Date.now(),
      id = randomUUID(),
      trace = clean(req.headers["x-os-dashboard-trace"] || id, 120);
    const config = getSettings(),
      isChat = path.endsWith("/chat/completions"),
      isResponses = path.endsWith("/responses");
    const isGeneration = isChat || isResponses;
    let data;
    const operation = clean(
      req.headers["x-os-dashboard-source"] || (isGeneration ? "chat" : "model-list"),
      64,
    );
    const event = {
      source: "ai-gateway",
      upstream_called: 0,
      service: config.fixture === true ? "Dockerflare örneği" : "AI Gateway",
      operation,
      kind: isChat ? "chat" : isResponses ? "responses" : "models",
      request_id: id,
      trace_id: trace,
      model: null,
    };
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    const policy = requestPolicy(
      config,
      event,
      store,
      controller.signal,
      req.socket.localPort,
      req.headers["x-os-dashboard-accounting"] === "workshop"
        ? store.charge
        : undefined,
    );
    const protectedGeneration = isGeneration && policy.active;
    if (protectedGeneration) {
      event.trace_id = auditIdentifier(trace, id, 120);
      event.operation = auditIdentifier(operation, "chat", 64);
    }
    let finished = false,
      inspectedInput;
    function finish(status, message, level = "info", detail = "") {
      if (finished) return;
      finished = true;
      res.off("close", disconnected);
      if (protectedGeneration) policy.skipPending();
      const price = config.prices?.find(
        (p) => p.model === (event.served_model || event.model),
      );
      if (
        price &&
        Number.isFinite(event.input_tokens) &&
        Number.isFinite(event.output_tokens)
      ) {
        event.cost_usd = usageCost(
          price,
          event.input_tokens,
          event.output_tokens,
          event.cached_tokens,
        );
        event.tariff = JSON.stringify(price);
      }
      const completed = {
        ...event,
        ts: Date.now(),
        duration: Date.now() - started,
        status,
        message,
        level,
        detail,
      };
      if (
        isGeneration &&
        req.headers["x-os-dashboard-accounting"] === "workshop" &&
        store.charge
      ) {
        store.batch(() => {
          store.record(completed);
          store.charge(id, 0, {
            ...completed,
            ts: started,
            cost_usd: event.upstream_called === 0 ? 0 : event.cost_usd,
          });
        });
      } else store.record(completed);
    }
    function reject(status, message, kind) {
      event.kind = kind;
      finish(status, message, status >= 500 ? "error" : "warn");
      if (!res.destroyed) res.setHeader("x-os-dashboard-request-id", id);
      return json(res, status, {
        error: { message, code: kind },
        request_id: id,
      });
    }
    if (req.headers["x-os-dashboard-policy-hop"])
      return reject(
        508,
        "Ağ geçitleri arasında döngü algılandı.",
        "ai_gateway_loop",
      );
    if (isGeneration) {
      try {
        data = await readJson(req);
      } catch (e) {
        if (protectedGeneration)
          return reject(
            e.status || 400,
            e.status === 413
              ? "İstek boyutu sınırı aşıldı."
              : "Geçerli JSON gerekli.",
            "invalid_input",
          );
        throw e;
      }
      if (
        typeof data?.model !== "string" ||
        (isChat ? !Array.isArray(data.messages) : data.input == null)
      ) {
        const message = isChat
          ? "model ve messages gerekli."
          : "model ve input gerekli.";
        return protectedGeneration
          ? reject(400, message, "invalid_input")
          : json(res, 400, { error: { message } });
      }
      event.model = protectedGeneration
        ? auditIdentifier(data.model, null, 140)
        : clean(data.model, 140);
    }
    if (config.rate && (protectedGeneration || config.upstream)) {
      recent = recent.filter((t) => t > started - 60000);
      if (recent.length >= config.rate)
        return reject(429, "Dakikalık istek sınırı doldu.", "rate_limit");
      recent.push(started);
    }
    if (protectedGeneration) {
      try {
        inspectedInput = await policy.check("input", () =>
          policyInput(data, isResponses),
        );
      } catch (e) {
        return controller.signal.aborted
          ? reject(499, "İstemci bağlantıyı kapattı.", "client_closed")
          : reject(e.status, e.message, e.code);
      }
      if (controller.signal.aborted)
        return reject(499, "İstemci bağlantıyı kapattı.", "client_closed");
    }
    if (!config.upstream)
      return reject(503, "Model endpoint’i henüz bağlanmadı.", "unconfigured");
    const url = new URL(config.upstream + path.slice("/v1".length));
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port) === req.socket.localPort
    )
      return reject(
        400,
        "AI Gateway kendi adresine bağlanamaz.",
        "invalid_endpoint",
      );
    const headers = {
      accept: data?.stream ? "text/event-stream" : "application/json",
      "accept-encoding": "identity",
    };
    if (protectedGeneration) headers["x-os-dashboard-policy-hop"] = "1";
    const keyOrigin = process.env.OS_DASHBOARD_KEY_ORIGIN || "https://api.openai.com";
    if (process.env.OS_DASHBOARD_UPSTREAM_KEY && url.origin === keyOrigin)
      headers.authorization = "Bearer " + process.env.OS_DASHBOARD_UPSTREAM_KEY;
    let body;
    if (isGeneration) {
      body = JSON.stringify(data);
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const client = (url.protocol === "https:" ? https : http).request(url, {
      method: isGeneration ? "POST" : "GET",
      headers,
    });
    const abort = () => client.destroy();
    res.once("close", abort);
    client.setTimeout(120000, () => client.destroy(new Error("timeout")));
    const deadline = protectedGeneration
      ? setTimeout(() => client.destroy(new Error("timeout")), 120000)
      : null;
    deadline?.unref();
    const response = once(client, "response");
    event.upstream_called = 1;
    client.end(body);
    try {
      const [up] = await response;
      const status = up.statusCode || 502,
        type = up.headers["content-type"] || "application/json";
      if (status >= 300 && status < 400) {
        if (protectedGeneration) up.destroy();
        else up.resume();
        return reject(502, "Model sunucusu yönlendirme döndürdü.", "redirect");
      }
      const responseType = type.includes("text/event-stream")
        ? "text/event-stream"
        : type.includes("json")
          ? "application/json"
          : "text/plain";
      const responseHeaders = {
        "content-type": responseType,
        "x-content-type-options": "nosniff",
        "x-os-dashboard-request-id": id,
        "cache-control": "no-store",
      };
      const stream = type.includes("text/event-stream");
      let carry = "",
        captured = 0,
        sawDone = false,
        streamError = false;
      const parts = [],
        decoder = new TextDecoder();
      const capture = (frame) => {
        if (frame?.type === "response.completed") sawDone = true;
        if (
          ["error", "response.failed", "response.incomplete"].includes(
            frame?.type,
          )
        )
          streamError = true;
        const obj = frame?.response || frame;
        if (typeof obj?.model === "string")
          event.served_model = protectedGeneration
            ? auditIdentifier(obj.model, null, 140)
            : clean(obj.model, 140);
        if (obj?.usage) {
          event.input_tokens = count(
            obj.usage.prompt_tokens ?? obj.usage.input_tokens,
          );
          event.output_tokens = count(
            obj.usage.completion_tokens ?? obj.usage.output_tokens,
          );
          event.cached_tokens = count(
            obj.usage.prompt_tokens_details?.cached_tokens ??
              obj.usage.input_tokens_details?.cached_tokens,
          );
        }
        if (
          obj?.error ||
          obj?.status === "failed" ||
          obj?.status === "incomplete"
        )
          streamError = true;
      };
      if (protectedGeneration) {
        if (status < 200 || status >= 300) {
          up.destroy();
          return reject(
            status >= 400 ? status : 502,
            "Model sunucusu isteği tamamlayamadı.",
            "upstream_error",
          );
        }
        const checked = await policy.check("output", () =>
          policyOutput(up, type, isResponses, inspectedInput, capture),
        );
        finish(
          status,
          "Model yanıtı tamamlandı",
          "info",
          stream ? "Denetlenen akışlı yanıt" : "Denetlenen JSON yanıt",
        );
        res.writeHead(status, responseHeaders);
        res.end(checked.wire);
        return;
      }
      res.writeHead(status, responseHeaders);
      for await (const chunk of up) {
        if (!res.write(chunk)) {
          await new Promise((resolve, reject) => {
            const done = () => {
              res.off("close", closed);
              resolve();
            };
            const closed = () => {
              res.off("drain", done);
              reject(new Error("closed"));
            };
            res.once("drain", done);
            res.once("close", closed);
          });
        }
        if (stream) {
          carry += decoder.decode(chunk, { stream: true });
          const lines = carry.split("\n");
          carry = lines.pop();
          if (carry.length > 1024 * 1024) carry = "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const item = line.slice(5).trim();
            if (item === "[DONE]") sawDone = true;
            else
              try {
                capture(JSON.parse(item));
              } catch {
                /* non-JSON SSE frame */
              }
          }
        } else {
          captured += chunk.length;
          if (captured <= 4 * 1024 * 1024) parts.push(chunk);
        }
      }
      if (!stream && captured <= 4 * 1024 * 1024) {
        try {
          capture(JSON.parse(Buffer.concat(parts).toString()));
        } catch {
          /* provider-specific response */
        }
      }
      const bad = status >= 400 || streamError || (stream && !sawDone);
      finish(
        status,
        bad
          ? "Model isteği hatayla sonuçlandı"
          : isGeneration
            ? "Model yanıtı tamamlandı"
            : "Model kataloğu okundu",
        bad ? "error" : "info",
        stream ? "Akışlı yanıt" : "JSON yanıt",
      );
      res.end();
    } catch (e) {
      if (e instanceof PolicyError) {
        client.destroy();
        return controller.signal.aborted
          ? reject(499, "İstemci bağlantıyı kapattı.", "client_closed")
          : reject(e.status, e.message, e.code);
      }
      const canceled = res.destroyed;
      finish(
        canceled ? 499 : 502,
        canceled
          ? "İstemci bağlantıyı kapattı"
          : "Model sunucusuna erişilemedi",
        "error",
      );
      if (!res.headersSent)
        json(res, 502, { error: { message: "Model sunucusuna erişilemedi." } });
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(deadline);
      res.off("close", abort);
    }
  };
}
