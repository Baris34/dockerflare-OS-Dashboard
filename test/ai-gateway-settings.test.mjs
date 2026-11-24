import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../server.mjs";
import { openStore } from "../lib/store.mjs";

test("checking a policy does not count as a second model request", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  for (const [source, operation, kind] of [
    ["policy", "input", "allow"],
    ["policy", "input", "block"],
    ["policy", "output", "skip"],
    ["ai-gateway", "chat", "guard_block"],
  ])
    store.record({ source, operation, kind, trace_id: "t", message: "test" });
  const { stats } = store.summary(Date.now() - 10_000);
  assert.equal(stats.requests, 1);
  assert.equal(stats.policy_checks, 2);
  assert.equal(stats.policy_blocks, 1);
  const events = store.events(
    new URLSearchParams({
      source: "policy",
      operation: "input",
      kind: "block",
      trace_id: "t",
    }),
  );
  assert.equal(events.total, 1);
  assert.equal(events.trace.events, 4);
});

test("policy settings survive partial updates, invalid settings and restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "os-dashboard-settings-"));
  let app = await start({ dir, port: 0, collect: false });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const update = (value) =>
    fetch(app.url + "/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const initial = await (await fetch(app.url + "/api/settings")).json();
  assert.equal(initial.guardRoot, "");
  assert.equal(initial.upstream, "");
  assert.equal(initial.guardAction, "block");
  const guard = {
    guardRoot: "http://guard:8000/v1",
    guardModel: "Qwen/Qwen3Guard-Gen-4B",
    guardAction: "flag",
    dlp: true,
  };
  assert.equal((await update(guard)).status, 200);
  assert.equal((await update({ rate: 5 })).status, 200);
  for (const invalid of [
    { guardAction: "ignore" },
    { guardRoot: "ftp://guard" },
    { guardRoot: "https://guard/v1?key=test" },
    { guardModel: "" },
    { fixture: true },
    { dlp: null },
  ]) {
    assert.equal((await update(invalid)).status, 400);
  }
  await app.close();
  app = await start({ dir, port: 0, collect: false });
  const snap = await (await fetch(app.url + "/api/overview")).json();
  for (const [k, v] of Object.entries(guard)) assert.equal(snap.settings[k], v);
  assert.equal(snap.stats.policy_blocks, 0);
  assert.equal(snap.settings.rate, 5);
  assert.equal(snap.settings.upstream, "");
  assert.equal((await update({ guardRoot: "" })).status, 200);
});

test("Docker clients can reach only authenticated inference routes on the private listener", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "os-dashboard-ingress-"));
  const token = "local-only-test-credential";
  const app = await start({
    dir,
    port: 0,
    collect: false,
    inference: { host: "127.0.0.1", port: 0, token },
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(app.inferenceUrl);
  const url = app.inferenceUrl;
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
  };
  assert.equal((await fetch(url + "/api/settings", { headers })).status, 404);
  assert.equal((await fetch(url + "/v1/models")).status, 401);
  assert.equal(
    (
      await fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "test", messages: [] }),
      })
    ).status,
    503,
  );
});

test(
  "panel-only service advertises the standalone AI Gateway and shares live policy and audit records with its process",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "os-dashboard-split-"));
    const tokenFile = join(dir, "client-token");
    const token = "separate-process-test";
    await writeFile(tokenFile, token + "\n", { mode: 0o600 });
    const advertised = "http://localhost:4322/v1";
    const panel = await start({
      dir,
      port: 0,
      collect: false,
      panelOnly: true,
      publicAiGatewayUrl: advertised,
    });
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    });
    assert.equal((await fetch(panel.url + "/v1/models")).status, 404);
    const overview = await (await fetch(panel.url + "/api/overview")).json();
    assert.equal(overview.publicAiGatewayUrl, advertised);
    assert.equal(overview.keyReady, null);
    assert.equal(overview.guardKeyReady, null);
    const entry = fileURLToPath(
      new URL("../ai-gateway-server.mjs", import.meta.url),
    );
    child = spawn(process.execPath, [entry], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        OS_DASHBOARD_DATA_DIR: dir,
        OS_DASHBOARD_CLIENT_TOKEN: "",
        OS_DASHBOARD_CLIENT_TOKEN_FILE: tokenFile,
        OS_DASHBOARD_INFERENCE_BIND: "127.0.0.1",
        OS_DASHBOARD_INFERENCE_PORT: "0",
      },
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(([code]) => {
        throw new Error("AI Gateway startup exit " + code);
      }),
    ]);
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url);
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    };
    assert.equal((await fetch(url + "/v1/models")).status, 401);
    assert.equal((await fetch(url + "/api/settings", { headers })).status, 404);
    const ask = () =>
      fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { ...headers, "x-os-dashboard-trace": "split-policy" },
        body: JSON.stringify({
          model: "local",
          messages: [{ role: "user", content: "4111 1111 1111 1111" }],
        }),
      });
    assert.equal((await ask()).status, 503);
    assert.equal(
      (
        await fetch(panel.url + "/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dlp: true }),
        })
      ).status,
      200,
    );
    assert.equal((await ask()).status, 424);
    const events = await (
      await fetch(
        panel.url +
          "/api/events?trace_id=split-policy&source=policy&kind=block",
      )
    ).json();
    assert.equal(events.total, 1);
    assert.equal(events.items[0].operation, "input");
    assert.equal(events.trace.requests, 2);
  },
);

test("standalone AI Gateway startup fails closed with an empty token file even with an environment token", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "os-dashboard-empty-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "token");
  await writeFile(file, "\n", { mode: 0o600 });
  const entry = fileURLToPath(
    new URL("../ai-gateway-server.mjs", import.meta.url),
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [entry], {
      timeout: 4000,
      windowsHide: true,
      env: {
        ...process.env,
        OS_DASHBOARD_DATA_DIR: dir,
        OS_DASHBOARD_CLIENT_TOKEN_FILE: file,
        OS_DASHBOARD_CLIENT_TOKEN: "synthetic-only",
        OS_DASHBOARD_INFERENCE_BIND: "127.0.0.1",
        OS_DASHBOARD_INFERENCE_PORT: "0",
      },
    }),
    (error) =>
      error.code === 1 && !error.killed && !error.stdout.includes("http://"),
  );
});

test("simultaneous processes upgrade a legacy SQLite file while preserving its records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "os-dashboard-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "os-dashboard.sqlite");
  const legacyFile = join(dir, "seyir.sqlite");
  const old = openStore(legacyFile);
  old.record({ source: "gateway", message: "retained" });
  old.close();
  const db = new DatabaseSync(legacyFile);
  db.exec(
    "ALTER TABLE events DROP COLUMN upstream_called; PRAGMA journal_mode=DELETE",
  );
  db.close();
  const storeModule = new URL("../lib/store.mjs", import.meta.url).href;
  const worker =
    "import {openStore} from " +
    JSON.stringify(storeModule) +
    ";const db = openStore(process.argv[1]); db.record({source:'ai-gateway',message:'new',upstream_called:1}); db.close();";
  await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", worker, file],
        { windowsHide: true, timeout: 10000 },
      ),
    ),
  );
  const current = openStore(file);
  try {
    const { items } = current.events(
      new URLSearchParams({ source: "ai-gateway" }),
    );
    assert.equal(items.length, 5);
    assert.equal(
      items.find((e) => e.message === "retained").upstream_called,
      null,
    );
    assert.equal(items.filter((e) => e.upstream_called === 1).length, 4);
  } finally {
    current.close();
  }
});
