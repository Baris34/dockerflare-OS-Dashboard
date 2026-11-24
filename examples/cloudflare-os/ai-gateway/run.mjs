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
const dbFile = join(resolve(process.env.SEYIR_DATA_DIR || join(root, "data", "current")), "seyir.sqlite");
const importVolume = process.env.SEYIR_IMPORT_VOLUME || "";
const prefix = "seyir-workshop-" + randomUUID();
const name = (suffix) => prefix + "-" + suffix;
const label = "seyir.demo.run=" + prefix;
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
  const gateways = events.filter(e => e.source === "gateway");
  assert.equal(events.length, 5 * gateways.length);
  assert.deepEqual(chats.map(row => row.model), Object.keys(expected));
  assert.deepEqual([...new Set(gateways.map(e => e.model))].sort(), Object.keys(expected).sort());
  assert.equal(new Set(gateways.map(e => e.request_id)).size, gateways.length);
  assert.equal(new Set(gateways.map(e => e.trace_id)).size, gateways.length);
  const report = gateways.map(gateway => {
    const { decisions, status } = expected[gateway.model];
    assert.equal(gateway.service, "Dockerflare örneği");
    assert.equal(gateway.status, status, gateway.model + " HTTP");
    assert.equal(gateway.upstream_called, Number(["demo-pass","demo-guard-out"].includes(gateway.model)));
    assert.match(gateway.trace_id, /^[a-f\d-]{36}$/);
    assert.match(gateway.request_id, /^[a-f\d-]{36}$/);
    const policy = events.filter(e => e.source === "policy" &&
      e.trace_id === gateway.trace_id && e.request_id === gateway.request_id);
    assert.equal(policy.length, stages.length);
    const actual = stages.map(([service, operation]) =>
      policy.find(e => e.service === service && e.operation === operation)?.kind);
    assert.deepEqual(actual, decisions, gateway.model + " politika kararları");
    return { model: gateway.model, chat: chats.find(c => c.model === gateway.model).chat,
      status, decisions: actual.join("/"), trace: gateway.trace_id };
  });
  // Count physical HTTP calls separately from stored decisions, including any Workshop retries.
  const attempts = id => report.filter(row => row.model === id).length;
  const allowed = attempts("demo-pass"), outputBlock = attempts("demo-guard-out");
  assert.deepEqual(model.models, { "demo-pass": allowed, "demo-guard-out": outputBlock });
  assert.equal(model.total, allowed + outputBlock);
  assert.equal(model.total, gateways.reduce((total, row) => total + row.upstream_called, 0));
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
for (const role of ["web", "workshop", "gateway", "model", "guard", "checks"]) {
  const tag = ["web", "workshop"].includes(role) ? "dockerflare/" + role + ":local" : "seyir/demo-" + role + ":local";
  images[role] = docker(["image", "inspect", "--format", "{{.Id}}", tag]);
}
function volumeImporter(check, events) {
  const mount = "type=volume,source=" + importVolume + ",target=/data,volume-nocopy";
  return docker(["run", "--rm", "-i", "--pull=never", "--network", "none", "--mount", mount,
    images.gateway, "node", "/app/examples/cloudflare-os/ai-gateway/import-events.mjs", ...(check ? ["--check"] : [])],
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
  for (const volume of ["worker-data", "gateway-data", "auth"])
    docker(["volume", "create", "--label", label, name(volume)]);
  start("model", "fixtures");
  start("guard", "fixtures");
  start("gateway", "front", ["-v", name("gateway-data") + ":/data", "-v", name("auth") + ":/auth"]);
  docker(["network", "connect", name("fixtures"), name("gateway")]);
  start("workshop", "front", ["-v", name("worker-data") + ":/data", "-e", "PUBLIC_BASE_URL=http://web:8080",
    "-e", 'ADMINS=["seyirdemo"]', "-e", 'SELF_HOSTED_MODEL_BASE_URLS=["http://gateway:8000/v1"]']);
  start("web", "front");
  const chats = JSON.parse(docker(["run", "--rm", "--pull=never", "--label", label, "--name", name("checks"),
    "--network", name("front"), "-v", name("auth") + ":/auth:ro", images.checks]));
  const evidence = JSON.parse(docker(["exec", name("gateway"), "node", "/demo/capture.mjs"]));
  const report = verify(chats, evidence);
  if (options.length) {
    const added = importVolume ? Number(volumeImporter(false, evidence.events)) : importEvents(dbFile, evidence.events);
    console.log("Halkness'e eklenen olay: " + added + " (" + (importVolume || dbFile) + ")");
  }
  console.table(report);
  console.log(`Model HTTP istekleri ${evidence.model.total}, Guard giriş denetimleri ${evidence.guard.input}, çıkış denetimleri ${evidence.guard.output}.`);
} finally {
  removeOwned(["container", "ls", "-aq"], ["container", "rm", "-f"]);
  removeOwned(["network", "ls", "-q"], ["network", "rm"]);
  removeOwned(["volume", "ls", "-q"], ["volume", "rm"]);
}
