import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStore } from "./lib/store.mjs";
import { readSettings } from "./lib/settings.mjs";
import { makeGateway } from "./lib/gateway.mjs";
import {
  createInferenceListener,
  listen,
  loadClientToken,
} from "./lib/inference-listener.mjs";

export async function startGateway(options = {}) {
  const host = options.host ?? process.env.SEYIR_INFERENCE_BIND ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.SEYIR_INFERENCE_PORT || 4322);
  const token = options.token ?? (await loadClientToken());
  const dir = resolve(
    options.dir ||
      process.env.SEYIR_DATA_DIR ||
      fileURLToPath(new URL("./data/current", import.meta.url)),
  );
  await mkdir(dir, { recursive: true });
  const store = openStore(join(dir, "seyir.sqlite"));
  let server;
  try {
    server = createInferenceListener(
      makeGateway(store, () => readSettings(store)),
      token,
    );
    await listen(server, port, host);
    store.record({
      source: "seyir",
      service: "Model gateway",
      kind: "startup",
      message: "Model ağ geçidi başlatıldı.",
    });
  } catch (error) {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    store.close();
    throw error;
  }
  const boundHost = server.address().address;
  return {
    url:
      "http://" +
      (boundHost.includes(":") ? "[" + boundHost + "]" : boundHost) +
      ":" +
      server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const gateway = await startGateway();
  console.log("Halkness gateway " + gateway.url);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => gateway.close().then(() => process.exit(0)));
}
