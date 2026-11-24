import { DatabaseSync } from "node:sqlite";

const columns = [
  "ts",
  "source",
  "service",
  "level",
  "message",
  "kind",
  "trace_id",
  "request_id",
  "model",
  "served_model",
  "status",
  "duration",
  "input_tokens",
  "output_tokens",
  "detail",
];
const extraColumns = {
  operation: "TEXT",
  upstream_called: "INTEGER",
  cached_tokens: "INTEGER",
  cost_usd: "REAL",
  tariff: "TEXT",
};
const levels = new Set(["info", "warn", "error"]);
export function usageCost(price, input, output, cached) {
  if (
    !price ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return null;
  const reused = Math.min(
    input,
    Number.isSafeInteger(cached) && cached > 0 ? cached : 0,
  );
  return (
    ((input - reused) * price.input +
      reused * price.cached +
      output * price.output) /
    1e6
  );
}
export function clean(value, max = 1500) {
  return String(value ?? "")
    .slice(0, 8192)
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [gizli]")
    .replace(
      /((?:authorization|set-cookie|cookie|password|passwd|api[-_]?key|access[-_]?token|secret)\s*["']?\s*[:=]\s*["']?)([^\s,;"']+)/gi,
      "$1[gizli]",
    )
    .replace(
      /\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]{15,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/g,
      "[gizli]",
    )
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, " ")
    .slice(0, max);
}
export function openStore(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT,service TEXT,level TEXT,message TEXT,kind TEXT,trace_id TEXT,request_id TEXT,model TEXT,served_model TEXT,status INTEGER,duration REAL,input_tokens INTEGER,output_tokens INTEGER,detail TEXT);
    CREATE INDEX IF NOT EXISTS by_time ON events(ts);
    CREATE INDEX IF NOT EXISTS by_source ON events(source,ts);
    CREATE INDEX IF NOT EXISTS by_trace ON events(trace_id);
    CREATE TABLE IF NOT EXISTS workshop_charge(
      request_id TEXT NOT NULL, part INTEGER NOT NULL, ts INTEGER NOT NULL, model TEXT,
      operation TEXT, status INTEGER, upstream_called INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cost_usd REAL, trace_id TEXT, served_model TEXT, cached_tokens INTEGER, PRIMARY KEY(request_id,part));
    CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, cpu REAL, ram REAL, used REAL, total REAL, disk REAL);
    CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    const current = new Set(
      db
        .prepare("PRAGMA table_info(events)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of Object.entries(extraColumns))
      if (!current.has(name))
        db.exec("ALTER TABLE events ADD COLUMN " + name + " " + type);
    const chargeFields = db
      .prepare("PRAGMA table_info(workshop_charge)")
      .all()
      .map((row) => row.name);
    if (!chargeFields.includes("served_model"))
      db.exec("ALTER TABLE workshop_charge ADD COLUMN served_model TEXT");
    if (!chargeFields.includes("cached_tokens"))
      db.exec("ALTER TABLE workshop_charge ADD COLUMN cached_tokens INTEGER");
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    throw error;
  }
  const eventColumns = [...columns, ...Object.keys(extraColumns)];
  const insert = db.prepare(
    "INSERT INTO events(" +
      eventColumns.join(",") +
      ") VALUES (" +
      eventColumns.map(() => "?").join(",") +
      ")",
  );
  const set = db.prepare(
    "INSERT INTO state VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
  );
  function put(key, v) {
    set.run(key, JSON.stringify(v));
  }
  function get(key, fallback = null) {
    const row = db.prepare("SELECT v FROM state WHERE k=?").get(key);
    return row ? JSON.parse(row.v) : fallback;
  }
  function record(data) {
    const row = {
      ...data,
      ts: data.ts ?? Date.now(),
      level: levels.has(data.level) ? data.level : "info",
      message: clean(data.message),
      detail: clean(data.detail),
    };
    return Number(
      insert.run(...eventColumns.map((k) => row[k] ?? null)).lastInsertRowid,
    );
  }
  function events(p) {
    const cond = [],
      args = [];
    for (const key of [
      "source",
      "level",
      "trace_id",
      "service",
      "kind",
      "operation",
    ])
      if (p.get(key)) {
        cond.push(key + "=?");
        args.push(p.get(key).slice(0, 200));
      }
    if (p.get("q")) {
      cond.push(
        "instr(lower(coalesce(message,'')||' '||coalesce(service,'')||' '||coalesce(model,'')||' '||coalesce(detail,'')),lower(?))>0",
      );
      args.push(p.get("q").slice(0, 200));
    }
    if (Number(p.get("since")) > 0) {
      cond.push("ts>=?");
      args.push(Number(p.get("since")));
    }
    const where = cond.length ? " WHERE " + cond.join(" AND ") : "";
    const total = db
      .prepare("SELECT count(*) AS n FROM events" + where)
      .get(...args).n;
    const limit = Math.max(1, Math.min(200, Number(p.get("limit")) || 60)),
      offset = Math.max(0, Math.floor(Number(p.get("offset")) || 0));
    const order =
      p.has("trace_id") && p.get("order") === "asc" ? "ASC" : "DESC";
    const items = db
      .prepare(
        "SELECT * FROM events" +
          where +
          ` ORDER BY ts ${order},id ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.floor(limit), offset);
    if (!p.get("trace_id")) return { total, items };
    const trace = db
      .prepare(
        `SELECT count(*) events,count(*) FILTER(WHERE source='gateway') requests,
      CASE WHEN count(*) FILTER(WHERE source='gateway' AND upstream_called IS NULL)=0
           THEN sum(upstream_called) FILTER(WHERE source='gateway') END upstream_calls,
      count(cost_usd) priced,sum(cost_usd) cost_usd FROM events WHERE trace_id=?`,
      )
      .get(p.get("trace_id").slice(0, 200));
    return { total, items, trace };
  }
  function sample(s) {
    db.prepare("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?)").run(
      s.ts,
      s.cpu,
      s.ram,
      s.used,
      s.total,
      s.disk,
    );
  }
  // These minimal accounting rows outlive the seven-day general log. Only the operator-selected
  // Workshop transport opts in. A chat is joined by a gateway-issued ID read from its own workspace.
  function charge(requestId, part, row) {
    db.prepare(
      `INSERT OR REPLACE INTO workshop_charge(request_id,part,ts,model,operation,status,
      upstream_called,input_tokens,output_tokens,cost_usd,trace_id,served_model,cached_tokens)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      requestId,
      part,
      row.ts,
      row.model ?? null,
      row.operation,
      row.status ?? null,
      row.upstream_called,
      row.input_tokens ?? null,
      row.output_tokens ?? null,
      row.cost_usd ?? null,
      row.trace_id ?? null,
      row.served_model ?? null,
      row.cached_tokens ?? null,
    );
  }
  function charges(ids) {
    if (!ids.length) return [];
    return db
      .prepare(
        `SELECT *, EXISTS(SELECT 1 FROM events WHERE trace_id=workshop_charge.trace_id) AS has_trace FROM workshop_charge
      WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY ts,part`,
      )
      .all(JSON.stringify(ids));
  }
  function summary(since) {
    const stats = db
      .prepare(
        `SELECT count(*) events,count(*) FILTER(WHERE source='gateway') requests,
      count(*) FILTER(WHERE level='error') errors,count(*) FILTER(WHERE source='gateway' AND status>=400) gateway_errors,
      count(*) FILTER(WHERE source='policy' AND kind!='skip') policy_checks,
      count(*) FILTER(WHERE source='policy' AND kind='block') policy_blocks,
      count(*) FILTER(WHERE source='policy' AND kind='flag') policy_flags,
      sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,count(cost_usd) priced,sum(cost_usd) cost_usd,avg(duration) FILTER(WHERE source='gateway') latency FROM events WHERE ts>=?`,
      )
      .get(since);
    const bucket = Math.max(1000, Math.round((Date.now() - since) / 200));
    const series = db
      .prepare(
        "SELECT max(ts) ts,round(avg(cpu),2) cpu,round(avg(ram),2) ram FROM samples WHERE ts>=? GROUP BY cast(ts/? AS INTEGER) ORDER BY ts",
      )
      .all(since, bucket);
    return {
      stats,
      series,
      latest:
        db.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1").get() ||
        null,
    };
  }
  function batch(fn) {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function prune() {
    const cutoff = Date.now() - 7 * 86400000;
    db.prepare("DELETE FROM samples WHERE ts<?").run(cutoff);
    db.prepare("DELETE FROM events WHERE ts<?").run(cutoff);
  }
  return {
    charge,
    charges,
    record,
    events,
    summary,
    sample,
    get,
    put,
    batch,
    prune,
    close: () => db.close(),
  };
}
