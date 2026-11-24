import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { makeAiGateway } from "/app/lib/ai-gateway.mjs";
import { createInferenceListener } from "/app/lib/inference-listener.mjs";
import { openStore } from "/app/lib/store.mjs";

const token = randomBytes(32).toString("hex");
writeFileSync("/auth/token", token, { mode: 0o400 });
const store = openStore("/data/os-dashboard.sqlite");
const proxy = makeAiGateway(store, () => ({
  upstream: "http://model:8000/v1", fixture: true, rate: 0, dlp: false,
  prices: [{ model: "os-dashboard-audit-demo", input: 2, cached: 1, output: 5 }],
}));
createInferenceListener(proxy, token).listen(4322);
