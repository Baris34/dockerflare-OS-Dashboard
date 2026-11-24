import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Open only the operator-configured metadata projection. Opening per read also follows
// a newly created or replaced snapshot without holding an old inode on the panel.
function withDatabase(file, read) {
  if (!file || !existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(
      "PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN",
    );
    const result = read(db);
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}

export function workshopReader(store, source, demoDir) {
  const sources = [{ file: source, demo: false }];
  if (demoDir)
    sources.push({ file: join(demoDir, "workshop.sqlite"), demo: true });

  function list(params) {
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(params.get("limit"), 10) || 50),
    );
    let offset = Math.max(0, Number.parseInt(params.get("offset"), 10) || 0);
    let total = 0,
      connected = false;
    const items = [];
    for (const { file, demo } of sources) {
      withDatabase(file, (db) => {
        if (!demo) connected = true;
        const count = db.prepare("SELECT count(*) AS n FROM chat").get().n;
        if (offset < count && items.length < limit) {
          const rows = db
            .prepare(
              `SELECT workspace_id,chat_id,started_at,updated_at,initiator FROM chat
            ORDER BY updated_at DESC,workspace_id,chat_id DESC LIMIT ? OFFSET ?`,
            )
            .all(limit - items.length, offset);
          items.push(...rows.map((row) => ({ ...row, demo })));
        }
        total += count;
        offset = Math.max(0, offset - count);
      });
    }
    return { items, total, connected };
  }

  function detail(params) {
    const workspace = params.get("workspace_id"),
      raw = params.get("chat_id");
    if (
      !/^[a-f0-9]{64}$/.test(workspace || "") ||
      !/^(0|[1-9]\d*)$/.test(raw || "") ||
      !Number.isSafeInteger(Number(raw))
    )
      throw Object.assign(new Error("Geçersiz sohbet kimliği."), {
        status: 400,
      });
    for (const { file, demo } of sources) {
      const chat = withDatabase(file, (db) => {
        const row = db
          .prepare(
            `SELECT workspace_id,chat_id,started_at,updated_at,initiator FROM chat
          WHERE workspace_id=? AND chat_id=?`,
          )
          .get(workspace, Number(raw));
        if (!row) return null;
        const events = db
          .prepare(
            `SELECT event_id,type,ts,name,actor,status,cost_usd,cost_source,
          request_id,operation,http_status,served_model,requested_model,input_tokens,output_tokens
          FROM chat_event WHERE workspace_id=? AND chat_id=?
          ORDER BY ts,event_id`,
          )
          .all(workspace, Number(raw));
        return { ...row, events, demo };
      });
      if (!chat) continue;
      const ids = chat.events
        .filter((e) => e.type === "model" && e.request_id)
        .map((e) => e.request_id);
      const charges = demo
        ? withDatabase(join(demoDir, "gateway.sqlite"), (db) =>
            db
              .prepare(
                `SELECT * FROM workshop_charge
            WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY ts,part`,
              )
              .all(JSON.stringify(ids)),
          ) || []
        : store.charges(ids);
      return applyCharges(chat, charges);
    }
    throw Object.assign(new Error("Sohbet bulunamadı."), { status: 404 });
  }
  return { list, detail };
}

function applyCharges(chat, charges) {
  const primary = new Map(
    charges.filter((row) => row.part === 0).map((row) => [row.request_id, row]),
  );
  const events = chat.events;
  let historical = false;
  for (const e of events) {
    if (e.type !== "model") continue;
    const row = primary.get(e.request_id);
    if (!row) {
      historical = true;
      continue;
    }
    e.cost_usd = row.cost_usd;
    e.cost_source = "gateway_estimate";
    e.http_status = row.status;
    e.input_tokens = row.input_tokens;
    e.output_tokens = row.output_tokens;
    e.cached_tokens = row.cached_tokens;
    e.served_model = row.served_model ?? e.served_model;
    e.name = e.served_model ?? e.name;
    // A blocked input still names the requested model. It never ran.
    if (row.upstream_called === 0)
      e.status = row.status === 424 ? "blocked" : "not_called";
    if (row.has_trace && !chat.demo) e.trace_id = row.trace_id;
  }
  for (const row of charges) {
    if (row.part === 0) continue;
    events.push({
      type: "guard",
      name: row.model,
      ts: row.ts,
      request_id: row.request_id,
      operation: row.operation,
      status: row.status >= 200 && row.status < 300 ? "http_ok" : "http_error",
      cost_usd: row.cost_usd,
      cost_source: "gateway_estimate",
      http_status: row.status,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cached_tokens: row.cached_tokens,
      trace_id: !chat.demo && row.has_trace ? row.trace_id : null,
    });
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  let priced = 0,
    unpriced = 0,
    cost = 0;
  for (const e of events) {
    if (e.type !== "model" && e.type !== "guard") continue;
    if (Number.isFinite(e.cost_usd) && e.cost_usd >= 0) {
      priced++;
      cost += e.cost_usd;
    } else unpriced++;
  }
  return {
    ...chat,
    events,
    priced,
    unpriced,
    cost_usd: priced ? cost : null,
    cost_complete: priced > 0 && !unpriced && !historical,
    coverage_note: historical
      ? "Bazı çağrılar için yalnız Workshop geçmişi var. Gateway ile eşleşmeyen yardımcı çağrıların maliyeti doğrulanamadı."
      : null,
  };
}
