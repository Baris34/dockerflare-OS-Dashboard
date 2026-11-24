import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { makeAiGateway } from "/app/lib/ai-gateway.mjs";
import { createInferenceListener } from "/app/lib/inference-listener.mjs";
import { openStore } from "/app/lib/store.mjs";

const store = openStore("/data/os-dashboard.sqlite");
const proxy = makeAiGateway(store, () => ({
  upstream: "http://model:8000/v1",
  guardRoot: "http://guard:8000/v1",
  guardModel: "fixture-guard",
  guardAction: "block",
  dlp: true,
  fixture: true,
  rate: 0,
  prices: [],
}));
const token = randomBytes(32).toString("hex");
writeFileSync("/auth/token", token, { mode: 0o400 });
createInferenceListener(proxy, token).listen(8000);
