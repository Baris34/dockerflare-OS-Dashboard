import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { localAccessEvent } from "../scripts/local-os.mjs";
import { start } from "../server.mjs";

test("reads Wrangler access lines and keeps only method, route class and status", () => {
  assert.deepEqual(localAccessEvent("\x1b[32m[wrangler:info]\x1b[0m GET /api/version 200 OK (4ms)"), {
    level: "info", message: "GET /api/version | HTTP 200",
  });
  assert.deepEqual(localAccessEvent("[wrangler:info] POST /gatekeeper/sample/private?ticket=sensitive 403 Forbidden (2ms)"), {
    level: "warn", message: "POST /gatekeeper | HTTP 403",
  });
  assert.equal(localAccessEvent("[wrangler:info] GET /api 101 Switching Protocols (3ms)").message, "GET /api | HTTP 101");
  assert.equal(localAccessEvent("[wrangler:info] GET / 500 Internal Server Error (1ms)").level, "error");
  for (const line of ["some worker output", "GET /api 200", "[wrangler:info] GET /assets/private 200 OK (1ms)"]) {
    assert.equal(localAccessEvent(line), null);
  }
});

test("a separate OS process and the panel share access records and the native Workshop snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "panel");
  const osDir = join(root, "os");
  await mkdir(join(osDir, "scripts"), { recursive: true });
  await writeFile(join(osDir, "scripts", "run-local.ts"), "");
  const panel = await start({ dir, port: 0, collect: false });
  try {
    const cli = fileURLToPath(new URL("../scripts/local-os.mjs", import.meta.url));
    const child = spawn(process.execPath, [cli], {
      cwd: osDir, env: { ...process.env, OS_DASHBOARD_DATA_DIR: dir, OS_DASHBOARD_LOG_DIR: "" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const finished = once(child, "close");
    child.stdin.end("private stdout\n[wrangler:info] GET /api/private?ticket=private 200 OK (1ms)\n");
    assert.equal((await finished)[0], 0);
    const stored = await readFile(join(dir, "logs", "dockerflare-local.jsonl"), "utf8");
    assert.deepEqual(JSON.parse(stored), { level: "info", message: "GET /api | HTTP 200" });
    await panel.collectFiles();
    const events = await fetch(panel.url + "/api/events?service=dockerflare-local.jsonl").then(r => r.json());
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0].message, "GET /api | HTTP 200");
    const chats = () => fetch(panel.url + "/api/workshop/chats").then(r => r.json());
    assert.equal((await chats()).connected, false);
    const db = new DatabaseSync(join(dir, "workshop-local.sqlite"));
    try {
      db.exec("CREATE TABLE chat(workspace_id TEXT,chat_id INTEGER,started_at INTEGER,updated_at INTEGER,initiator TEXT); INSERT INTO chat VALUES('workspace',1,10,10,'test-user')");
    } finally {
      db.close();
    }
    assert.equal((await chats()).items[0].initiator, "test-user");
  } finally {
    await panel.close();
  }
});
