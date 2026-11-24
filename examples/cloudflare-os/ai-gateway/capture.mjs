import { DatabaseSync } from "node:sqlite";

// This process runs inside the AI Gateway container. All three volumes are unique to this run.
const db = new DatabaseSync("/data/os-dashboard.sqlite", { readOnly: true });
const events = db.prepare(`SELECT ts,source,service,operation,kind,level,message,detail,
  trace_id,request_id,model,served_model,status,duration,input_tokens,output_tokens,cached_tokens,cost_usd,upstream_called
  FROM events WHERE source IN ('ai-gateway','policy') ORDER BY id`).all();
db.close();
async function counts(host) {
  const response = await fetch("http://" + host + ":8000/counts", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Fixture sayacı alınamadı");
  return response.json();
}
const [model, guard] = await Promise.all([counts("model"), counts("guard")]);
console.log(JSON.stringify({ events, model, guard }));
