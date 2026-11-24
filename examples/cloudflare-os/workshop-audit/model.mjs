import { createServer } from "node:http";
import assert from "node:assert/strict";

let calls = 0;
const name = "seyir-audit-demo";
function tool(id, name, args) {
  return { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] };
}
createServer(async (req,res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  try {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts));
    assert.equal(body.stream, true);
    assert.equal(body.model, name);
    const step = ++calls;
    let delta;
    if (step === 1) {
      delta = tool("local-arithmetic","executeCode",{
        code: 'export default async function() { console.log("DEMO_TOOL_RESULT_" + (6 * 7)); }',
      });
    } else if (step === 2) {
      assert.ok(body.messages.some(m => m.role === "tool" && m.tool_call_id === "local-arithmetic" &&
        JSON.stringify(m.content).includes("DEMO_TOOL_RESULT_42")));
      delta = tool("local-connection","requestConnection",{
        vendorId:"agent-spawner", reason:"Yerel örnek bağlantı", bindingName:"LOCAL_HELPER",
      });
    } else if (step === 3) {
      delta = tool("held-creation","createExternalResource",{
        vendorId:"google", resourceTypeId:"document", title:"Taslak örneği", bindingName:"PROPOSED_DOC",
      });
    } else if (step === 4) {
      delta = { role:"assistant",content:"Yerel deneme tamamlandı." };
    } else throw new Error("Unexpected model round");
    const frame = (choices, more = {}) => "data: " + JSON.stringify({
      id: "demo-" + step, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model:name, choices, ...more,
    }) + "\n\n";
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.write(frame([{index:0,delta,finish_reason:null}]));
    res.write(frame([{index:0,delta:{},finish_reason:delta.tool_calls ? "tool_calls" : "stop"}]));
    res.end(frame([], {usage:{prompt_tokens:120,completion_tokens:20,total_tokens:140}}) + "data: [DONE]\n\n");
  } catch {
    res.writeHead(400,{"content-type":"application/json"}).end('{"error":{"message":"Demo step mismatch"}}');
  }
}).listen(8000);
