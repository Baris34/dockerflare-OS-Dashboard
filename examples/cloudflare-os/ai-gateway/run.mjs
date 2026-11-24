import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDatabase, importEvents } from "./import-events.mjs";

const cwd = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const options = process.argv.slice(2);
if (options.length > 1 || (options.length && options[0] !== "--import"))
  throw new Error("Kullanım: node run.mjs [--import]");
const dbFile = join(resolve(process.env.OS_DASHBOARD_DATA_DIR || join(root, "data", "current")), "os-dashboard.sqlite");
const importVolume = process.env.OS_DASHBOARD_IMPORT_VOLUME || "";
const prefix = "os-dashboard-workshop-" + randomUUID();
const name = (suffix) => prefix + "-" + suffix;
const label = "os-dashboard.demo.run=" + prefix;
function docker(args, input) {
  const windows = process.platform === "win32";
  return execFileSync(windows ? "wsl.exe" : "docker",
    windows ? ["-d", "Ubuntu", "-e", "docker", ...args] : args,
    { cwd, timeout: 180_000, input, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] }).trim();
}

// Order of decisions per request: DLP input, Guard input, DLP output, Guard output.
const expected = {
  "demo-pass":      { status: 200, decisions: ["allow", "allow", "allow", "allow"] },
  "demo-dlp":       { status: 424, decisions: ["block", "skip", "skip", "skip"] },
  "demo-guard-in":  { status: 424, decisions: ["allow", "block", "skip", "skip"] },
  "demo-guard-out": { status: 424, decisions: ["allow", "allow", "allow", "block"] },
};
const stages = [
  ["DLP · Dockerflare örneği", "input"], ["Guard test servisi", "input"],
  ["DLP · Dockerflare örneği", "output"], ["Guard test servisi", "output"],
];
function verify(chats, { events, model, guard }) {
  const aiGatewayEvents = events.filter(e => e.source === "ai-gateway");
  assert.equal(events.length, 5 * aiGatewayEvents.length);
  assert.deepEqual(chats.map(row => row.model), Object.keys(expected));
  assert.deepEqual([...new Set(aiGatewayEvents.map(e => e.model))].sort(), Object.keys(expected).sort());
  assert.equal(new Set(aiGatewayEvents.map(e => e.request_id)).size, aiGatewayEvents.length);
  assert.equal(new Set(aiGatewayEvents.map(e => e.trace_id)).size, aiGatewayEvents.length);
  const report = aiGatewayEvents.map(aiGateway => {
    const { decisions, status } = expected[aiGateway.model];
    assert.equal(aiGateway.service, "Dockerflare örneği");
    assert.equal(aiGateway.status, status, aiGateway.model + " HTTP");
    assert.equal(aiGateway.upstream_called, Number(["demo-pass","demo-guard-out"].includes(aiGateway.model)));
    assert.match(aiGateway.trace_id, /^[a-f\d-]{36}$/);
    assert.match(aiGateway.request_id, /^[a-f\d-]{36}$/);
    const policy = events.filter(e => e.source === "policy" &&
      e.trace_id === aiGateway.trace_id && e.request_id === aiGateway.request_id);
    assert.equal(policy.length, stages.length);
    const actual = stages.map(([service, operation]) =>
      policy.find(e => e.service === service && e.operation === operation)?.kind);
    assert.deepEqual(actual, decisions, aiGateway.model + " politika kararları");
    return { model: aiGateway.model, chat: chats.find(c => c.model === aiGateway.model).chat,
      status, decisions: actual.join("/"), trace: aiGateway.trace_id };
  });
  // Count physical HTTP calls separately from stored decisions, including any Workshop retries.
  const attempts = id => report.filter(row => row.model === id).length;
  const allowed = attempts("demo-pass"), outputBlock = attempts("demo-guard-out");
  assert.deepEqual(model.models, { "demo-pass": allowed, "demo-guard-out": outputBlock });
  assert.equal(model.total, allowed + outputBlock);
  assert.equal(model.total, aiGatewayEvents.reduce((total, row) => total + row.upstream_called, 0));
  assert.equal(guard.input, allowed + attempts("demo-guard-in") + outputBlock);
  assert.equal(guard.output, allowed + outputBlock);
  assert.equal(guard.total, guard.input + guard.output);
  const text = JSON.stringify(events);
  for (const needle of ["DEMO_AMBER_", "4242 4242", "Gökyüzünün rengini", "bir renk adı ver",
    "Demo yanıtı tamamlandı.", "Örnek test kartı", "Bu örnekte"])
    assert.ok(!text.includes(needle), "Örnek içerik telemetriye yazıldı");
  return report;
}

const images = {};
for (const role of ["web", "workshop", "ai-gateway", "model", "guard", "checks"]) {
  const tag = ["web", "workshop"].includes(role) ? "dockerflare/" + role + ":local" : "os-dashboard/demo-" + role + ":local";
  images[role] = docker(["image", "inspect", "--format", "{{.Id}}", tag]);
}
function volumeImporter(check, events) {
  const mount = "type=volume,source=" + importVolume + ",target=/data,volume-nocopy";
  return docker(["run", "--rm", "-i", "--pull=never", "--network", "none", "--mount", mount,
    images["ai-gateway"], "node", "/app/examples/cloudflare-os/ai-gateway/import-events.mjs", ...(check ? ["--check"] : [])],
    events && JSON.stringify(events));
}
if (options.length) {
  if (importVolume) {
    assert.match(importVolume, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "Geçerli bir Docker volume adı gerekli");
    docker(["volume", "inspect", "--format", "{{.Name}}", importVolume]);
    volumeImporter(true);
  } else checkDatabase(dbFile);
}
function start(role, network, extra = []) {
  return docker(["run", "--pull=never", "-d", "--label", label, "--name", name(role),
    "--network", name(network), "--network-alias", role, ...extra, images[role]]);
}
function removeOwned(listArgs, removeArgs) {
  try {
    const ids = docker([...listArgs, "--filter", "label=" + label]);
    if (ids) docker([...removeArgs, ...ids.split(/\s+/)]);
  } catch {
    console.error("Şu etiketin kaynakları temizlenemedi: " + label);
    process.exitCode = 1;
  }
}
try {
  for (const network of ["front", "fixtures"])
    docker(["network", "create", "--internal", "--label", label, name(network)]);
  for (const volume of ["worker-data", "ai-gateway-data", "auth"])
    docker(["volume", "create", "--label", label, name(volume)]);
  start("model", "fixtures");
  start("guard", "fixtures");
  start("ai-gateway", "front", ["-v", name("ai-gateway-data") + ":/data", "-v", name("auth") + ":/auth"]);
  docker(["network", "connect", name("fixtures"), name("ai-gateway")]);
  start("workshop", "front", ["-v", name("worker-data") + ":/data", "-e", "PUBLIC_BASE_URL=http://web:8080",
    "-e", 'ADMINS=["dashboarddemo"]', "-e", 'SELF_HOSTED_MODEL_BASE_URLS=["http://ai-gateway:8000/v1"]']);
  start("web", "front");
  const chats = JSON.parse(docker(["run", "--rm", "--pull=never", "--label", label, "--name", name("checks"),
    "--network", name("front"), "-v", name("auth") + ":/auth:ro", images.checks]));
  const evidence = JSON.parse(docker(["exec", name("ai-gateway"), "node", "/demo/capture.mjs"]));
  const report = verify(chats, evidence);
  if (options.length) {
    const added = importVolume ? Number(volumeImporter(false, evidence.events)) : importEvents(dbFile, evidence.events);
    console.log("OS Dashboard'a eklenen olay: " + added + " (" + (importVolume || dbFile) + ")");
  }
  console.table(report);
  console.log(`Model HTTP istekleri ${evidence.model.total}, Guard giriş denetimleri ${evidence.guard.input}, çıkış denetimleri ${evidence.guard.output}.`);
} finally {
  removeOwned(["container", "ls", "-aq"], ["container", "rm", "-f"]);
  removeOwned(["network", "ls", "-q"], ["network", "rm"]);
  removeOwned(["volume", "ls", "-q"], ["volume", "rm"]);
}
