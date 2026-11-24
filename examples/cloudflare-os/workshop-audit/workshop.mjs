import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { webSocketConnection } from "/src/packages/api-cli/src/session.ts";

const origin = "http://web:8080", user = "auditdemo", model = "os-dashboard-audit-demo";
const reviewer = "auditreview";
for (let attempt = 0; ; attempt++) {
  try {
    const version = await fetch(origin + "/api/version", { signal: AbortSignal.timeout(1500) });
    if (version.ok && Object.hasOwn(await version.json(), "version")) break;
  } catch { /* wait for Worker boot */ }
  if (attempt === 89) throw new Error("Workshop başlatılamadı");
  await delay(1000);
}
using session = webSocketConnection("ws://web:8080/api", { Origin:origin }).main;
using api = await session.authenticate(await session.createAccount(user, "Audit demo", randomBytes(32)));
assert.equal(await api.amIAdmin(), true);
await api.addModel({type:"agent",id:model,name:model},{
  provider:"openai-compatible", model, apiUrl:"http://ai-gateway:4322/v1", apiToken:readFileSync("/auth/token","utf8"),
});
using ws = await api.newWorkspace();
const workspace = (await ws.getMetadata()).id;
const chat = await ws.newChat("Yerel araç ve onay denetimi örneğini çalıştır.", model);
const connection = await ws.waitForAgent(chat);
assert.equal(connection?.type,"connectionRequest");
assert.equal(connection.state,"pending");
using reviewSession = webSocketConnection("ws://web:8080/api", {Origin:origin}).main;
using reviewApi = await reviewSession.authenticate(await reviewSession.createAccount(reviewer, "Audit reviewer", randomBytes(32)));
assert.equal(await reviewApi.amIAdmin(), false);
assert.ok(await ws.addCollaborator(reviewer, "workspace"));
using reviewWs = await reviewApi.openWorkspace(workspace);
using spawner = await reviewWs.newAgentSpawnerGatekeeper({displayName:"Yerel yardımcı", modelId:null, env:{}});
await reviewWs.acceptConnectionRequest(connection.requestId,{gatekeeperId:await spawner.getId()});
const last = await ws.waitForAgent(chat);
assert.equal(last?.type,"message");
assert.equal(last.message,"Yerel deneme tamamlandı.");
const page = await ws.listActions({filter:"pending"});
assert.equal(page.entries.length,1);
const [action] = page.entries;
assert.equal(action.state,"pending");
await ws.rejectAction(action.id);
const resolved = (await ws.listActions({filter:"action"})).entries.find(entry=>entry.id===action.id);
assert.equal(resolved.state,"rejected");
assert.equal(resolved.resolvedBy.id,user);
const {messages} = await ws.getChatHistory(chat);
const starter = messages.find(m=>m.type==="message" && m.author.type==="user");
assert.equal(starter.author.id,user);
const accepted = messages.find(m=>m.type==="connectionRequest");
assert.equal(accepted.state,"accepted");
assert.equal(accepted.decidedBy,reviewer);
const tools = messages.flatMap(m=>m.toolCalls?.map(t=>t.toolName) || []);
assert.deepEqual(tools,["executeCode","requestConnection","createExternalResource"]);
console.log(JSON.stringify({workspace,chat,starter:starter.author.id,model,tools,connection:"accepted",acceptedBy:accepted.decidedBy,
  action:resolved.state,decidedBy:resolved.resolvedBy.id}));
