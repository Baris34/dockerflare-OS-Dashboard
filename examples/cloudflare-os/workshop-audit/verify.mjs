import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "/app/lib/store.mjs";

const audit = new DatabaseSync("/audit/workshop.sqlite", { readOnly: true });
const gateway = new DatabaseSync("/data/seyir.sqlite", { readOnly: true });
const [chat] = audit.prepare("SELECT workspace_id,chat_id,initiator FROM chat").all();
assert.equal(audit.prepare("SELECT count(*) n FROM chat").get().n, 1);
assert.equal(chat.initiator, "auditdemo");
const events = audit.prepare("SELECT * FROM chat_event WHERE workspace_id=? AND chat_id=?").all(chat.workspace_id, chat.chat_id);
const executed = events.filter(e => e.type === "tool" && e.status === "executed").map(e => e.name).sort();
assert.deepEqual(executed, ["createExternalResource","executeCode","requestConnection"]);
assert.ok(events.some(e => e.type === "approval" && e.status === "approved" && e.actor === "auditreview"));
assert.ok(events.some(e => e.type === "approval" && e.status === "denied" && e.actor === "auditdemo"));
const modelCalls = events.filter(e => e.type === "model");
assert.equal(modelCalls.length, 4);
const byId = new Set(modelCalls.map(e => e.request_id));
assert.equal(byId.size, 4);
const measured = gateway.prepare(`SELECT ts,source,service,operation,kind,level,message,detail,trace_id,request_id,
  model,served_model,status,duration,input_tokens,output_tokens,cached_tokens,cost_usd,tariff,upstream_called
  FROM events WHERE source='gateway' ORDER BY id`).all();
assert.equal(measured.length, 4);
assert.equal(new Set(measured.map(r=>r.request_id)).size, 4);
const charges = gateway.prepare(`SELECT request_id,part,ts,model,operation,status,upstream_called,input_tokens,
  output_tokens,cost_usd,trace_id,served_model,cached_tokens FROM workshop_charge ORDER BY ts`).all();
assert.equal(charges.length, 4);
for (const row of measured) {
  assert.ok(byId.has(row.request_id), "Model isteği gateway kimliğiyle eşleşmedi");
  assert.equal(row.model, "seyir-audit-demo");
  assert.equal(row.status, 200);
  assert.equal(row.input_tokens, 120);
  assert.equal(row.output_tokens, 20);
  assert.equal(Math.round(row.cost_usd * 1e6), 340);
  const charge = charges.find(charge => charge.request_id === row.request_id && charge.part === 0);
  assert.ok(charge, "Workshop muhasebe kaydı bulunamadı");
  for (const field of ["status","upstream_called","model","served_model","input_tokens","output_tokens","cached_tokens","cost_usd","trace_id"])
    assert.equal(charge[field],row[field]);
}
// Only the selected metering columns cross into the result volume. Raw Workshop storage is ephemeral.
for (const marker of ["DEMO_TOOL_RESULT_", "Yerel araç ve onay", "Yerel deneme tamamlandı.", "Taslak örneği"])
  assert.ok(!JSON.stringify([chat,events,measured]).includes(marker));
const projection = openStore("/result/gateway.sqlite");
try {
  projection.batch(() => {
    for (const row of measured) projection.record(row);
    for (const charge of charges) projection.charge(charge.request_id, charge.part, charge);
  });
} finally { projection.close(); }
audit.exec("VACUUM INTO '/result/workshop.sqlite'");
audit.close();
gateway.close();
for (const file of ["workshop","gateway"]) {
  const snapshot = new DatabaseSync("/result/" + file + ".sqlite");
  snapshot.exec("PRAGMA journal_mode=DELETE");
  snapshot.close();
}
console.log(JSON.stringify({ workspace: chat.workspace_id, chat: chat.chat_id, initiator:chat.initiator,
  tools:executed, modelRequests:measured.length, inputTokens:480, outputTokens:80,
  sampleTariffUsd:measured.reduce((sum,row) => sum + row.cost_usd, 0) }));
