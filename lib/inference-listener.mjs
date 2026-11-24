import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { json } from "./gateway.mjs";

export function isInferenceRoute(method, path) {
  return (
    (method === "GET" && path === "/v1/models") ||
    (method === "POST" &&
      ["/v1/chat/completions", "/v1/responses"].includes(path))
  );
}

export async function loadClientToken() {
  const file = process.env.SEYIR_CLIENT_TOKEN_FILE;
  if (!file) return process.env.SEYIR_CLIENT_TOKEN;
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("Gateway anahtar dosyası geçersiz.");
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// Only authenticated server clients can access these inference routes.
export function createInferenceListener(proxy, token) {
  if (!token?.trim())
    throw new Error(
      "Çıkarım portu için SEYIR_CLIENT_TOKEN veya SEYIR_CLIENT_TOKEN_FILE gerekli.",
    );
  const hash = (value) => createHash("sha256").update(value).digest();
  const expected = hash("Bearer " + token);
  return http.createServer(async (req, res) => {
    try {
      if (!isInferenceRoute(req.method, req.url))
        return json(res, 404, { error: "Bulunamadı." });
      if (!timingSafeEqual(expected, hash(req.headers.authorization || "")))
        return json(res, 401, { error: "Geçerli gateway anahtarı gerekli." });
      if (req.headers.origin || req.headers["sec-fetch-site"] === "cross-site")
        return json(res, 403, { error: "Sunucu istemcisi gerekli." });
      if (
        req.method === "POST" &&
        !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
      )
        return json(res, 415, { error: "application/json gerekli." });
      await proxy(req, res, req.url);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        json(res, error.status || 500, {
          error: error.status ? error.message : "İşlem tamamlanamadı.",
        });
    }
  });
}
