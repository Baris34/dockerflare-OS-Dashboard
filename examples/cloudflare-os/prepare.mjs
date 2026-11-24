import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the OS web configuration so its routing and WebSocket handling stay in sync.
const root = fileURLToPath(new URL("../../", import.meta.url));
const original = resolve(process.argv[2] || resolve(root, "../dockerflare-os/docker/web.conf"));
const configPath = resolve(root, "data/cloudflare-os/web.conf");
const eventPath = resolve(root, "data/logs/cloudflare-os-web.jsonl");
const base = await readFile(original, "utf8");
const disabled = /^(\s*)access_log off;[ \t]*\r?$/gm;
if ([...base.matchAll(disabled)].length !== 1)
  throw new Error("Beklenen nginx access_log off ayarı bulunamadı veya birden çok kez tanımlanmış.");

const format = `map $uri $os_dashboard_route {
    default "";
    /api/version /api/version;
    /healthz /healthz;
    ~^/api(/|$) /api;
    ~^/gatekeeper(/|$) /gatekeeper;
    ~^/blueprint-screenshot(/|$) /blueprint-screenshot;
}
map $os_dashboard_route $os_dashboard_trace {
    "" "";
    default $request_id;
}
map $status $os_dashboard_level {
    default info;
    ~^4 warn;
    ~^5 error;
}
log_format os-dashboard escape=json '{"time":"$time_iso8601","level":"$os_dashboard_level","trace_id":"$request_id","message":"$request_method $os_dashboard_route | HTTP $status | $request_time sn","status":$status,"upstream_status":"$upstream_status","duration_s":$request_time}';
`;
const config = base.replace(disabled, (_, indent) => [
  "access_log /dev/stdout os-dashboard if=$os_dashboard_route;",
  "access_log /var/log/nginx/os-dashboard-web.jsonl os-dashboard if=$os_dashboard_route;",
  "add_header X-OS-Dashboard-Trace $os_dashboard_trace always;",
].map(line => indent + line).join("\n"));
await mkdir(dirname(configPath), { recursive: true });
await mkdir(dirname(eventPath), { recursive: true });
await writeFile(configPath, format + "\n" + config);
// nginx appends to this single bind-mounted file. Keep earlier events on reconfiguration.
await (await open(eventPath, "a", 0o660)).close();
console.log(configPath);
console.log(eventPath);
