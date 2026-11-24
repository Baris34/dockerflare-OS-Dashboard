import os from "node:os";
import { readdir, open, statfs } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clean } from "./store.mjs";

const exec = promisify(execFile);
const run = (program, args) =>
  exec(program, args, {
    windowsHide: true,
    timeout: 7500,
    maxBuffer: 3 * 1024 * 1024,
    encoding: "utf8",
  });
const levelOf = (text) =>
  /\b(error|fatal|critical|exception|hata)\b/i.test(text)
    ? "error"
    : /\b(warn(?:ing)?|uyarı)\b/i.test(text)
      ? "warn"
      : "info";
function cpuTime() {
  let total = 0,
    idle = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const n of Object.values(c.times)) total += n;
  }
  return { idle, total };
}
export function sources(store, dir, options) {
  let prev = cpuTime(),
    containers = [],
    closed = false;
  const status = {
    host: { name: "Sunucu", state: "live", note: os.hostname() },
    system: {
      name:
        process.platform === "win32" ? "Windows olayları" : "Sistem günlüğü",
      state: "waiting",
      note: "Sistem günlüğü kontrol ediliyor.",
    },
    files: {
      name: "Log dosyaları",
      state: "waiting",
      note: "logs klasörü izleniyor.",
    },
    docker: {
      name: "Docker",
      state: "waiting",
      note: "Docker motoru kontrol ediliyor.",
    },
  };
  const go = (key, state, note) => {
    status[key] = {
      ...status[key],
      state,
      note: clean(note, 220),
      checked: Date.now(),
    };
  };
  async function sample() {
    const cur = cpuTime(),
      delta = cur.total - prev.total;
    const cpu =
      delta > 0
        ? Math.min(100, Math.max(0, 100 * (1 - (cur.idle - prev.idle) / delta)))
        : null;
    prev = cur;
    const total = os.totalmem(),
      used = total - os.freemem();
    let disk = null;
    try {
      const fs = await statfs(dir);
      disk = fs.blocks ? 100 * (1 - fs.bavail / fs.blocks) : null;
    } catch {
      /* volume does not expose usage */
    }
    if (!closed)
      store.sample({
        ts: Date.now(),
        cpu,
        ram: (100 * used) / total,
        used,
        total,
        disk,
      });
  }
  async function files() {
    const list = (await readdir(options.logs, { withFileTypes: true })).filter(
      (f) => f.isFile() && /\.(log|jsonl|ndjson)$/i.test(f.name),
    );
    for (const entry of list) {
      const name = entry.name,
        p = join(options.logs, name);
      let fh;
      try {
        fh = await open(p, "r");
        const st = await fh.stat();
        const key = "file:" + name;
        const marker = String(st.ino) + ":" + st.birthtimeMs;
        const old = store.get(key);
        let pos =
          old?.marker === marker && st.size >= old.pos
            ? old.pos
            : Math.max(0, st.size - 262144);
        if (pos === st.size) continue;
        const buf = Buffer.alloc(Math.min(262144, st.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        const read = buf.subarray(0, bytesRead);
        const last = read.lastIndexOf(10);
        if (last < 0) {
          if (bytesRead === 262144)
            store.put(key, { marker, pos: pos + bytesRead, skip: true });
          continue;
        }
        const skip = old?.marker === marker ? old.skip : pos > 0;
        const first = skip ? read.indexOf(10) + 1 : 0;
        const lines = read
          .subarray(first, last + 1)
          .toString("utf8")
          .split(/\r?\n/)
          .filter(Boolean);
        if (closed) return;
        store.batch(() => {
          for (const line of lines) {
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              /* plain text */
            }
            const msg =
              obj?.message ??
              obj?.msg ??
              (obj && typeof obj === "object"
                ? "Yapılandırılmış log olayı"
                : line);
            store.record({
              source: "files",
              service: clean(name, 150),
              message: msg,
              level: levelOf(String(obj?.level || "") + " " + msg),
              kind: "log",
              trace_id: obj?.trace_id ? clean(obj.trace_id, 120) : null,
            });
          }
          store.put(key, { marker, pos: pos + last + 1, skip: false });
        });
      } finally {
        await fh?.close();
      }
    }
    go(
      "files",
      list.length ? "live" : "ready",
      list.length
        ? list.length + " log dosyası izleniyor."
        : "Log dosyası bekleniyor.",
    );
  }
  async function system() {
    if (process.platform === "win32") {
      const after = (n) =>
        Math.max(0, Number.parseInt(store.get("win:" + n, 0), 10) || 0);
      const cmd = `
        [Console]::OutputEncoding=[Text.Encoding]::UTF8
        $ErrorActionPreference='Stop'
        $position=@{ System=${after("System")}; Application=${after("Application")} }
        $rows=foreach($n in 'System','Application'){
          $cursor=$position[$n]
          try {
            if ($cursor -gt 0) {
              $entries=Get-WinEvent -LogName $n -FilterXPath "*[System[EventRecordID > $cursor]]" -Oldest -MaxEvents 400
            } else {
              $entries=Get-WinEvent -FilterHashtable @{LogName=$n;StartTime=(Get-Date).AddHours(-6)} -MaxEvents 80
            }
          } catch {
            if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { continue }
            throw
          }
          $entries | Select-Object @{n='time';e={$_.TimeCreated.ToUniversalTime().ToString('o')}},LogName,RecordId,ProviderName,Id,Level,@{n='message';e={($_.Message -split '[\\r\\n]')[0]}}
        }
        ConvertTo-Json -Compress -InputObject @($rows)`;
      const { stdout } = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        cmd,
      ]);
      if (closed) return;
      const rows = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "[]");
      store.batch(() => {
        for (const r of rows.sort((a, b) => a.RecordId - b.RecordId)) {
          const k = "win:" + r.LogName;
          if (r.RecordId <= store.get(k, 0)) continue;
          store.record({
            ts: Date.parse(r.time),
            source: "system",
            service: clean(r.ProviderName),
            kind: r.LogName,
            level:
              r.Level === 3
                ? "warn"
                : r.Level <= 2 && r.Level >= 1
                  ? "error"
                  : "info",
            message: r.message || "Windows sistem olayı",
            detail: r.LogName + " · Olay " + r.Id,
          });
          store.put(k, r.RecordId);
        }
      });
      go("system", "live", "Application ve System kanalları");
    } else {
      const cursor = store.get("journal.cursor");
      const args = cursor
        ? ["--after-cursor", cursor, "-o", "json", "--no-pager", "--quiet"]
        : [
            "--since",
            "6 hours ago",
            "-n",
            "150",
            "-o",
            "json",
            "--no-pager",
            "--quiet",
          ];
      const { stdout } = await run("journalctl", args);
      if (closed) return;
      store.batch(() => {
        for (const line of stdout.trim().split("\n").filter(Boolean)) {
          const r = JSON.parse(line);
          const p = Number(r.PRIORITY);
          store.record({
            ts: Math.floor(Number(r.__REALTIME_TIMESTAMP) / 1000) || Date.now(),
            source: "system",
            service: clean(r.SYSLOG_IDENTIFIER || r._SYSTEMD_UNIT || "journal"),
            level: p <= 3 ? "error" : p === 4 ? "warn" : "info",
            kind: "journal",
            message: typeof r.MESSAGE === "string" ? r.MESSAGE : "Sistem olayı",
          });
          store.put("journal.cursor", r.__CURSOR);
        }
      });
      go(
        "system",
        stdout.trim() || cursor ? "live" : "ready",
        "Okunabilir journal kayıtları",
      );
    }
  }
  async function docker() {
    let output;
    try {
      output = await run("docker", [
        "ps",
        "--no-trunc",
        "--format",
        "{{json .}}",
      ]);
    } catch (err) {
      containers = [];
      go(
        "docker",
        "off",
        err.code === "ENOENT"
          ? "Docker CLI bulunamadı."
          : "Docker motoruna erişilemiyor.",
      );
      return;
    }
    if (closed) return;
    containers = output.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const r = JSON.parse(line);
        return {
          id: r.ID,
          name: clean(r.Names),
          image: clean(r.Image),
          status: clean(r.Status),
        };
      });
    let failed = 0;
    for (const c of containers) {
      if (closed) return;
      const key = "container:" + c.id,
        old = store.get(key),
        since = old?.last || new Date(Date.now() - 600000).toISOString();
      try {
        const { stdout, stderr } = await run("docker", [
          "logs",
          "--timestamps",
          "--tail",
          "250",
          "--since",
          since,
          c.id,
        ]);
        if (closed) return;
        const logs = (stdout + "\n" + stderr)
          .split(/\r?\n/)
          .map((l) => l.match(/^(\d{4}-\S+) (.*)$/))
          .filter(Boolean)
          .sort((a, b) => a[1].localeCompare(b[1]));
        let last = old?.last || "",
          seen = new Map(old?.atLast || []),
          group = new Map();
        store.batch(() => {
          for (const [, at, msg] of logs) {
            if (at < last) continue;
            if (at !== last) {
              last = at;
              seen = new Map();
              group = new Map();
            }
            const keyMsg = clean(msg),
              occ = (group.get(keyMsg) || 0) + 1;
            group.set(keyMsg, occ);
            if (occ <= (seen.get(keyMsg) || 0)) continue;
            store.record({
              ts: Date.parse(at) || Date.now(),
              source: "docker",
              service: c.name,
              kind: "container",
              level: levelOf(msg),
              message: keyMsg,
            });
          }
          if (logs.length)
            store.put(key, {
              last,
              atLast: [...new Set([...seen.keys(), ...group.keys()])].map(
                (k) => [k, Math.max(seen.get(k) || 0, group.get(k) || 0)],
              ),
            });
        });
      } catch {
        failed++;
      }
    }
    go(
      "docker",
      failed ? "partial" : "live",
      containers.length +
        " çalışan konteyner" +
        (failed ? " · " + failed + " günlük okunamadı" : ""),
    );
  }
  const timers = [],
    pending = new Set();
  function watch(fn, ms, onError) {
    let running = false;
    const tick = () => {
      if (running || closed) return;
      running = true;
      const task = fn()
        .catch(onError)
        .finally(() => {
          running = false;
          pending.delete(task);
        });
      pending.add(task);
    };
    tick();
    const timer = setInterval(tick, ms);
    timer.unref();
    timers.push(timer);
  }
  function start() {
    watch(sample, 2500, () => go("host", "off", "Kaynak ölçümü alınamadı."));
    watch(files, 4000, () =>
      go("files", "partial", "Log klasöründeki bir dosya okunamadı."),
    );
    watch(system, 30000, () =>
      go("system", "off", "Sistem günlüğü erişilebilir değil."),
    );
    watch(docker, 20000, () =>
      go("docker", "off", "Docker taraması tamamlanamadı."),
    );
  }
  async function stop() {
    closed = true;
    timers.forEach(clearInterval);
    await Promise.allSettled([...pending]);
  }
  function host() {
    return {
      name: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      cores: os.availableParallelism(),
      cpuModel: os.cpus()[0]?.model || "CPU",
      uptime: os.uptime(),
      total: os.totalmem(),
      containers,
      logsDir: options.logs,
      volume: basename(dir),
    };
  }
  return { start, stop, status, files, sample, host };
}
