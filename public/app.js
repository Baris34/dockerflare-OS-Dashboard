import { icon } from "./icons.js";

const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (v, d = 0) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("tr-TR", { maximumFractionDigits: d });
const time = (v, sec = false) =>
  new Date(v).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    ...(sec ? { second: "2-digit" } : {}),
  });
const day = (v) =>
  new Date(v).toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
const gib = (v) => num(v / 1073741824, 1) + " GiB";
const duration = (v) =>
  v < 60
    ? Math.floor(v) + " sn"
    : v < 3600
      ? Math.floor(v / 60) + " dk"
      : v < 86400
        ? Math.floor(v / 3600) + " sa"
        : Math.floor(v / 86400) +
          " gün " +
          Math.floor((v % 86400) / 3600) +
          " sa";
const pages = {
  overview: ["Genel bakış", "Sistem özeti", "grid"],
  logs: ["Log akışı", "Log akışı", "logs"],
  gateway: ["AI Gateway", "AI Gateway", "shield"],
  workshop: ["Workshop", "Workshop sohbetleri", "chat"],
  host: ["Sunucu", "Sunucu sağlığı", "server"],
  sources: ["Veri kaynakları", "Veri kaynakları", "plug"],
};
const sourceNames = {
  seyir: "Halkness",
  host: "Sunucu",
  files: "Dosya",
  system: "Sistem",
  docker: "Docker",
  gateway: "Gateway",
  policy: "Koruma kararları",
  ingest: "Uygulama",
};
const sourceIcons = {
  host: "monitor",
  system: "logs",
  files: "folder",
  docker: "box",
  gateway: "activity",
  ingest: "code",
};
const rangeNames = {
  900: "Son 15 dakika",
  3600: "Son 1 saat",
  21600: "Son 6 saat",
  86400: "Son 24 saat",
};
let page = "overview",
  range = 3600,
  live = true,
  info = null,
  eventPage = { items: [], total: 0 },
  offset = 0,
  search = "",
  severity = "",
  source = "",
  gatewayTab = "policy",
  traceId = "",
  workspaceId = "",
  chatId = "",
  workshopResult = null,
  decision = "",
  stage = "",
  version = 0,
  previousHead = "",
  timer,
  noticeTimer,
  netError = "";
const pageSize = 35;
const chatPageSize = 50;
const decisionNames = {
  allow: ["İzin verildi", "green"],
  flag: ["İşaretlendi", "amber"],
  block: ["Engellendi", "red"],
  error: ["Hata", "red"],
  skip: ["Atlandı", ""],
};
const stageNames = { input: "Girdi", output: "Çıktı" };
const defaultGuardModel = "Qwen/Qwen3Guard-Gen-4B";
const traceHref = (id) => "#gateway?" + new URLSearchParams({ trace: id });
const btn = (action, label, ic = "", cls = "") =>
  `<button class="btn ${cls}" data-a="${action}">${ic ? icon(ic, 15) : ""}${label}</button>`;
const chip = (text, cls = "") =>
  `<span class="chip ${cls}">${esc(text)}</span>`;
const stateChip = (v) => {
  const map = {
    live: ["Canlı", "green"],
    ready: ["Hazır", "blue"],
    off: ["Bağlı değil", ""],
    partial: ["Kısmi", "amber"],
    waiting: ["Bekliyor", "amber"],
  };
  return chip(...(map[v] || map.waiting));
};
const levelChip = (s) =>
  s === "error"
    ? chip("Hata", "red")
    : s === "warn"
      ? chip("Uyarı", "amber")
      : chip("Bilgi", "blue");
const statIcon = (name, color = "") =>
  `<span class="kpiIco ${color}">${icon(name, 16)}</span>`;
const keyVal = (rows) =>
  `<dl class="dlgGrid">${rows
    .filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("")}</dl>`;
async function api(url, opts) {
  const r = await fetch(url, { cache: "no-store", ...opts });
  let data = await r.json();
  if (!r.ok) {
    const error = new Error(
      typeof data.error === "string"
        ? data.error
        : data.error?.message || "İstek başarısız.",
    );
    error.status = r.status;
    throw error;
  }
  return data;
}
function toast(text) {
  $("#notice").textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").textContent = ""), 3000);
}
function nav() {
  for (const [id, keys] of [
    ["#nav", ["overview", "logs", "gateway", "workshop", "host"]],
    ["#adminNav", ["sources"]],
  ])
    $(id).innerHTML = keys
      .map(
        (k) =>
          `<a href="#${k}" class="navItem ${k === page ? "active" : ""}" ${k === page ? 'aria-current="page"' : ""}>${icon(pages[k][2])}${pages[k][0]}</a>`,
      )
      .join("");
}
function updateHead() {
  $("#crumb").textContent = pages[page][0];
  const title = page === "workshop" && (workspaceId || chatId) ? "Sohbet ayrıntısı" : pages[page][1];
  document.title = "Halkness · " + title;
  const ranges = Object.entries(rangeNames)
    .map(
      ([t, n]) =>
        `<option value="${t}" ${range == t ? "selected" : ""}>${n}</option>`,
    )
    .join("");
  const date = day(Date.now()),
    host = info?.host.name || "localhost";
  const showRange = page !== "sources" && page !== "workshop" && !traceId;
  const headMarkup =
    `<div class="titleRow"><div><h1>${title}</h1><div class="titleMeta">${icon("server", 14)}<span>${esc(host)}</span><span class="mid">/</span><span>${date}</span></div></div><div class="titleActions">${showRange ? `<label class="range">${icon("clock", 15)}<select id="range" aria-label="Zaman aralığı">${ranges}</select>${icon("down", 12)}</label>` : ""}<button class="btn ${live ? "live" : ""}" data-a="live" title="Otomatik yenilemeyi ${live ? "duraklat" : "aç"}"><i class="dot ${live ? "" : "dim"}"></i>${live ? "Canlı" : "Duraklatıldı"}</button><button class="iconbtn" data-a="refresh" aria-label="Veriyi yenile">${icon("refresh", 15)}</button></div></div>`;
  const head = $("#pageHead");
  if (headMarkup !== previousHead) {
    const control = head.contains(document.activeElement) ? document.activeElement : null;
    const selector = control?.id ? "#" + CSS.escape(control.id)
      : control?.dataset.a ? "[data-a=" + CSS.escape(control.dataset.a) + "]" : null;
    head.innerHTML = headMarkup;
    previousHead = headMarkup;
    if (selector) head.querySelector(selector)?.focus({ preventScroll: true });
  }
}
function filters() {
  const option = (v, n, selected) =>
    `<option value="${v}" ${v === selected ? "selected" : ""}>${n}</option>`;
  const isPolicy = page === "gateway" && gatewayTab === "policy";
  const select = (id, label, entries, selected) =>
    `<select id="${id}" aria-label="${label}">${entries.map(([v, n]) => option(v, n, selected)).join("")}</select>`;
  const common = select("severity", "Olay seviyesi", [
    ["", "Tüm seviyeler"], ["info", "Bilgi"], ["warn", "Uyarı"], ["error", "Hata"],
  ], severity);
  const decisions = isPolicy ? select("decision", "Karar türü", [
    ["", "Tüm kararlar"], ...Object.entries(decisionNames).map(([k, [n]]) => [k, n]),
  ], decision) + select("stage", "Denetim aşaması", [
    ["", "Girdi ve çıktı"], ...Object.entries(stageNames),
  ], stage) : "";
  const sources = page === "logs" ? select("source", "Log kaynağı", [
    ["", "Tüm kaynaklar"], ...Object.entries(sourceNames).filter(([k]) => k !== "host"),
  ], source) : "";
  return `<div class="pageFilters"><label class="searchbox">${icon("search", 16)}<input id="query" aria-label="${isPolicy ? "Kararlarda ara" : "Loglarda ara"}" value="${esc(search)}" placeholder="${isPolicy ? "Kural, model veya servis ara…" : "Olay veya servis ara…"}"></label>${decisions}${common}${sources}</div>`;
}
function spark(key, color) {
  const vals = (info?.series || [])
    .map((v) => v[key])
    .filter(Number.isFinite)
    .slice(-16);
  if (vals.length < 2) return "";
  const min = Math.min(...vals) - 1,
    max = Math.max(...vals) + 1;
  const points = vals
    .map(
      (v, i) =>
        `${((i * 58) / (vals.length - 1)).toFixed(1)},${(20 - ((v - min) / (max - min)) * 17).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="spark" width="62" height="22" viewBox="0 0 62 22" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
function kpi(label, value, unit, note, ic, color, action, s = "") {
  return `<button class="kpi" data-a="${action}"><div class="kpiTop">${statIcon(ic, color)}${label}</div><div class="kpiVal">${value}<small>${unit}</small></div><div class="kpiInfo">${esc(note)}</div>${s}</button>`;
}
function kpis() {
  const { latest: l, stats } = info;
  return `<div class="kpis">${kpi("CPU kullanımı", num(l?.cpu, 1), "%", info.host.cores + " mantıksal çekirdek", "cpu", "", "host", spark("cpu", "#e78845"))}${kpi("Bellek kullanımı", num(l?.ram, 1), "%", l ? gib(l.used) + " / " + gib(l.total) : "Ölçüm bekleniyor", "ram", "teal", "host", spark("ram", "#35a594"))}${kpi("Toplam olay", num(stats.events), "", stats.errors + " hata kaydı", "logs", "blue", "logs")}${kpi("Model istekleri", num(stats.requests), "", info.settings.upstream ? "Gateway üzerinden" : "Endpoint bekleniyor", "wave", "purple", "traffic")}</div>`;
}
function chart() {
  const samples = info.series.filter(
      (v) => Number.isFinite(v.cpu) && Number.isFinite(v.ram),
    ),
    w = 560,
    h = 146,
    x0 = 29,
    r = 6,
    y0 = 5,
    y1 = 137;
  const first = samples[0]?.ts ?? Date.now(),
    last = samples.at(-1)?.ts ?? first,
    dx = Math.max(1, last - first);
  const x = (v) => x0 + ((w - x0 - r) * (v.ts - first)) / dx;
  const y = (n) => y1 - ((y1 - y0) * n) / 100;
  const path = (k) =>
    samples
      .map((v, i) => `${i ? "L" : "M"}${x(v).toFixed(1)},${y(v[k]).toFixed(1)}`)
      .join(" ");
  const grid = [0, 25, 50, 75, 100]
    .map(
      (n) =>
        `<line x1="${x0}" x2="${w - r}" y1="${y(n)}" y2="${y(n)}" stroke="#414953" stroke-dasharray="3 5"/><text x="1" y="${y(n) + 3}" fill="#a6b1ba" font-size="9" font-family="monospace">${n}</text>`,
    )
    .join("");
  const lines = [
    ["ram", "#69c8b8"],
    ["cpu", "#ff9f52"],
  ]
    .map(([k, c]) => {
      const p = path(k);
      if (!p) return "";
      const end = samples.at(-1);
      return `<path d="${p} L${x(end)},${y1} L${x0},${y1} Z" fill="url(#grad-${k})"/><path d="${p}" stroke="${c}" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" fill="none"/><circle cx="${x(end)}" cy="${y(end[k])}" r="3" fill="${c}"/>`;
    })
    .join("");
  const labels =
    samples.length > 1
      ? [first, first + dx / 3, first + (2 * dx) / 3, last]
      : [first];
  return `<section class="chart"><div class="cardHead"><div><div class="eyebrow"><i class="dot orange"></i>SİSTEM TELEMETRİSİ</div><h2>Kaynak kullanımı</h2></div><div class="legend"><span><i></i>CPU</span><span><i></i>RAM</span></div></div><div class="plot" id="plot"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="CPU ve bellek kullanımı, yüzde"><defs><linearGradient id="grad-cpu" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ff9f52" stop-opacity=".23"/><stop offset="1" stop-color="#ff9f52" stop-opacity=".02"/></linearGradient><linearGradient id="grad-ram" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#69c8b8" stop-opacity=".14"/><stop offset="1" stop-color="#69c8b8" stop-opacity=".015"/></linearGradient></defs>${grid}${lines}</svg><span class="plotTip"></span></div><div class="timeaxis">${labels.map((t) => `<span>${time(t, dx < 600000)}</span>`).join("")}</div><div class="chartFoot"><span>${live ? "Otomatik yenileme açık" : "Görünüm duraklatıldı"}</span><span class="axisNote">${samples.length} ölçüm noktası</span></div></section>`;
}
function compactSources() {
  return `<section class="panel sourcesCard"><div class="cardHead"><h2>Veri kaynakları</h2><button class="linkButton" data-a="sources" aria-label="Kaynakları yönet">${icon("filter", 16)}</button></div><div class="sourcesList">${["host", "system", "files", "docker", "gateway"].map((k) => `<div class="srcLine"><span class="sourceName">${icon(sourceIcons[k], 16)}${esc(info.sources[k].name)}</span>${stateChip(info.sources[k].state)}</div>`).join("")}</div></section>`;
}
function pagination() {
  return `<div class="footerRow"><span>${eventPage.total ? num(offset + 1) + "–" + num(Math.min(offset + pageSize, eventPage.total)) + " / " + num(eventPage.total) : "0 kayıt"}</span><div class="toolbar"><button class="btn" data-a="prev" ${offset === 0 ? "disabled" : ""}>Önceki</button><button class="btn" data-a="next" ${offset + pageSize >= eventPage.total ? "disabled" : ""}>Sonraki</button></div></div>`;
}
function table(title, compact = false) {
  const entries = eventPage.items;
  const rows = entries
    .map(
      (e) =>
        `<tr tabindex="0" aria-label="${esc(e.message)}" data-event="${esc(e.id)}"><td class="time">${time(e.ts, true)}</td><td>${levelChip(e.level)}</td><td class="service" title="${esc(e.service)}">${esc(e.service)}</td><td class="msg" title="${esc(e.message)}">${esc(e.message)}</td><td class="colGo">${icon("chevron", 13)}</td></tr>`,
    )
    .join("");
  const message =
    page === "gateway"
      ? "Henüz model isteği yok"
      : "Bu aralıkta eşleşen olay yok";
  return `<section class="panel"><div class="panelHead"><h2>${title} <span class="pillCount">${num(eventPage.total)}</span></h2>${compact ? `<button class="linkButton" data-a="logs">Tüm loglar ${icon("chevron", 13)}</button>` : ""}</div>${rows ? `<div class="tableWrap"><table class="eventTable"><thead><tr><th class="colTime">ZAMAN</th><th class="colLevel">SEVİYE</th><th class="colSource">SERVİS</th><th>OLAY</th><th class="colGo"></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${icon(page === "gateway" ? "activity" : "search", 24)}<strong>${message}</strong>${page === "gateway" ? "İstemcini Halkness gateway adresine bağladığında çağrılar burada görünür." : "Zaman aralığını veya filtreleri değiştirebilirsin."}</div>`}${compact ? "" : pagination()}</section>`;
}
function tiles() {
  const h = info.host;
  const details = {
    host: "CPU, bellek, disk ve çalışma süresi",
    system: info.sources.system.note,
    files: h.logsDir,
    docker: info.sources.docker.note,
    gateway: info.sources.gateway.note,
    ingest: "POST /api/events",
  };
  return `<div class="tileGrid">${["host", "system", "files", "docker", "gateway", "ingest"].map((k) => `<section class="tile panel"><div class="cardHead"><div class="tileIcon">${icon(sourceIcons[k])}</div>${stateChip(info.sources[k]?.state || "ready")}</div><h2>${esc(info.sources[k]?.name || "Uygulama olayları")}</h2><p style="overflow-wrap:anywhere">${esc(details[k])}</p>${btn("detail-" + k, k === "gateway" ? "Bağlantıyı düzenle" : "Ayrıntıları aç", k === "gateway" ? "plug" : "layers")}</section>`).join("")}</div>`;
}
function reading(label, value, small = false) {
  return `<div class="readout panel"><small>${label}</small><strong ${small ? 'class="smallVal"' : ""}>${esc(value)}</strong></div>`;
}
function hostView() {
  const h = info.host,
    l = info.latest;
  return `<div class="machine">${reading("Makine", h.name, true)}${reading("İşletim sistemi", h.platform + " · " + h.arch, true)}${reading("Çalışma süresi", duration(h.uptime))}${reading("Disk doluluğu", l?.disk == null ? "—" : num(l.disk, 1) + "%")}</div><div class="overviewGrid blockGap">${chart()}<section class="tile panel"><h2>Donanım</h2>${keyVal(
    [
      ["İşlemci", h.cpuModel],
      ["Çekirdek", h.cores],
      ["Bellek", gib(h.total)],
      ["Sistem sürümü", h.release],
    ],
  )}</section></div><section class="tile panel"><h2>Docker servisleri</h2>${
    h.containers.length
      ? h.containers
          .map((c) =>
            keyVal([
              ["Konteyner", c.name],
              ["İmaj", c.image],
              ["Durum", c.status],
            ]),
          )
          .join("")
      : `<p>${esc(info.sources.docker.note)}</p>`
  }</section>`;
}
function money(value) {
  return value == null
    ? "\u2014"
    : Number(value).toLocaleString("tr-TR", { maximumFractionDigits: 7 }) +
        " USD";
}
function trafficView() {
  const s = info.stats;
  return `<div class="statusPanel panel"><div><strong>${info.settings.upstream ? "Model gateway yapılandırıldı" : "Model endpoint’i bağla"}</strong><p>${info.publicGatewayUrl ? "İstemci API kökü <code>" + esc(info.publicGatewayUrl) + "</code>" : info.settings.upstream ? esc(info.settings.upstream) : "OpenAI veya OpenAI uyumlu sunucun üzerinden geçen çağrıları izle."}</p></div><div class="toolbar">${btn("prices", "Tarifeler")}${btn("config", "Bağlantı ayarları", "plug", "primary")}</div></div><div class="machine">${reading("İstek", num(s.requests))}${reading("Giriş tokenı", num(s.input_tokens))}${reading("Çıkış tokenı", num(s.output_tokens))}${reading("Ortalama süre", s.latency == null ? "—" : num(s.latency) + " ms")}${reading("Tahmini maliyet", money(s.cost_usd))}${reading("Fiyatlanan istek", num(s.priced) + " / " + num(s.requests))}</div><div class="blockGap">${filters()}${table("Model çağrıları")}</div>`;
}
function policyBadge(kind) {
  const [label, color] = Object.hasOwn(decisionNames, kind)
    ? decisionNames[kind]
    : [kind || "Bilinmiyor", ""];
  return chip(label, color);
}
function fixtureLabel(service) {
  if (service === "Guard test servisi") return "Test servisi";
  if (service === "DLP · Dockerflare örneği") return "Dockerflare örneği";
  return "";
}
function policyStatus(title, symbol, state, active, description) {
  return `<section class="policyStatus"><div class="statusHeading"><span class="policySymbol">${icon(symbol, 18)}</span><h2>${title}</h2><span class="policyState ${active ? "enabled" : ""}"><i></i>${state}</span></div><p>${esc(description)}</p></section>`;
}
function policyStats() {
  const s = info.stats;
  return `<dl class="policyStats">${[
    ["Çalışan denetim", s.policy_checks, "layers", "blue"],
    ["Engellenen", s.policy_blocks, "shield", "red"],
    ["İşaretlenen", s.policy_flags, "circle", "amber"],
  ].map(([name, value, glyph, tone]) => `<div><dt>${statIcon(glyph, tone)}${name}</dt><dd>${num(value)}</dd></div>`).join("")}</dl>`;
}
function policyView() {
  const cfg = info.settings;
  const status = policyStatus("Yerel DLP", "shield", cfg.dlp ? "Açık" : "Kapalı", cfg.dlp, "Girdi ve çıktıda kart numaraları ve bilinen API anahtarı biçimleri") +
    policyStatus("Guard modeli", "layers", cfg.guardRoot ? "Yapılandırıldı" : "Yapılandırılmadı", !!cfg.guardRoot, cfg.guardRoot
      ? (cfg.guardModel || defaultGuardModel) + " · " + (cfg.guardAction === "flag" ? "İşaretle ve geçir" : "Engelle")
      : "Qwen3Guard denetimi için bir Guard API adresi gerekli.");
  const rows = eventPage.items.map((e) => {
    const fixture = fixtureLabel(e.service);
    const engine = e.service === "DLP · Dockerflare örneği" ? "DLP" : e.service;
    return `<tr tabindex="0" aria-label="${esc(e.message)}" data-event="${esc(e.id)}"><td class="time">${time(e.ts, true)}</td><td>${policyBadge(e.kind)}</td><td>${esc(stageNames[e.operation] || e.operation || "—")}</td><td><div class="policyEngine">${esc(engine || "—")}${fixture ? `<small>${esc(fixture)}</small>` : ""}</div></td><td class="ruleCell"><span>${esc(e.detail || e.message || "—")}</span></td><td class="colGo">${icon("chevron", 13)}</td></tr>`;
  }).join("");
  return `<div class="policyStatusBar">${status}</div>${policyStats()}<section class="panel policyPanel">
    <div class="panelHead"><h2>Karar günlüğü <span class="pillCount">${num(eventPage.total)}</span></h2></div>
    ${filters()}
    ${rows ? `<div class="tableWrap"><table class="eventTable policyTable"><thead><tr><th class="colTime">ZAMAN</th><th class="decisionCol">KARAR</th><th class="stageCol">AŞAMA</th><th class="engineCol">DENETLEYİCİ</th><th>KURAL / GEREKÇE</th><th class="colGo"></th></tr></thead><tbody>${rows}</tbody></table></div>` :
      `<div class="empty">${icon("shield", 24)}<strong>Bu aralıkta eşleşen karar yok</strong>Denetim kayıtlarını görmek için zaman aralığını ve filtreleri kontrol edebilirsin.</div>`}
    ${pagination()}</section>`;
}
function traceView() {
  const trace = eventPage.trace;
  const rows = eventPage.items.map((e) => {
    const isPolicy = e.source === "policy";
    const timestamp = new Date(e.ts).toLocaleTimeString("tr-TR", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
    });
    const outcome = e.source === "gateway" && e.status != null
      ? chip("HTTP " + e.status, e.status < 400 ? "green" : "red")
      : isPolicy ? policyBadge(e.kind) : levelChip(e.level);
    return `<tr tabindex="0" data-event="${esc(e.id)}" aria-label="${esc(e.message)}"><td class="time">${timestamp}</td><td>${outcome}</td><td class="service">${esc(e.service)}</td><td class="ruleCell"><span>${isPolicy ? esc((stageNames[e.operation] || e.operation || "Denetim") + " · " + (e.detail || e.message)) : esc(e.message)}</span></td><td class="colGo">${icon("chevron", 13)}</td></tr>`;
  }).join("");
  return `<a class="traceBack" href="#gateway">${icon("chevron", 14)} Karar günlüğü</a><section class="panel tracePanel">
    <div class="panelHead"><div><h2>İstek izi</h2><code class="traceId">${esc(traceId)}</code></div></div>
    ${trace ? `<div class="traceSummary">${num(trace.events)} olay <span>·</span> ${num(trace.requests)} gateway isteği <span>·</span> Ana model çağrısı ${num(trace.upstream_calls)} <span>·</span> Tahmini maliyet ${money(trace.cost_usd)}</div>` : ""}
    ${rows ? `<div class="tableWrap"><table class="eventTable traceTable"><thead><tr><th class="colTime">ZAMAN</th><th class="decisionCol">SONUÇ</th><th class="engineCol">SERVİS</th><th>OLAY</th><th class="colGo"></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty">${icon("search", 24)}<strong>Bu iz kimliğiyle kayıt bulunamadı</strong></div>`}
    ${pagination()}</section>`;
}
function gatewayView() {
  if (traceId) return traceView();
  const tabs = [["policy", "#gateway", "Koruma kararları", "shield"], ["traffic", "#gateway?view=traffic", "Model trafiği", "activity"]];
  return `<div class="gatewayNav"><nav aria-label="Gateway görünümleri">${tabs.map(([view, href, label, symbol]) =>
    `<a href="${href}" ${gatewayTab === view ? 'aria-current="page"' : ""}>${icon(symbol, 16)}${label}</a>`).join("")}</nav>
    ${gatewayTab === "policy" ? btn("policy-config", "Koruma ayarları", "filter") : ""}</div>
    ${gatewayTab === "policy" ? policyView() : trafficView()}`;
}
function workshopHref(start = 0, workspace, chat) {
  const query = new URLSearchParams();
  if (workspace && chat != null && chat !== "") {
    query.set("workspace_id", workspace);
    query.set("chat_id", chat);
  }
  if (start > 0) query.set("offset", start);
  return "#workshop" + (query.size ? "?" + query : "");
}
async function loadWorkshop() {
  const detail = Boolean(workspaceId || chatId);
  if (detail && !(workspaceId && chatId))
    return { error: "Sohbeti açmak için çalışma alanı ve sohbet kimliği gerekli." };
  const query = detail ? new URLSearchParams({ workspace_id: workspaceId, chat_id: chatId })
    : new URLSearchParams({ offset, limit: chatPageSize });
  try {
    const data = await api((detail ? "/api/workshop/chat?" : "/api/workshop/chats?") + query);
    return { data };
  } catch (error) {
    if (detail && error.status === 404) return { error: "Bu çalışma alanında sohbet bulunamadı." };
    return { error: "Workshop kayıtlarına erişilemiyor." };
  }
}
function chatTime(value) {
  if (value == null || value === "") return "Bilinmiyor";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("tr-TR", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }) : "Bilinmiyor";
}
function chatBack() {
  return `<a class="traceBack" href="${esc(workshopHref(offset))}">${icon("chevron", 14)} Sohbet listesi</a>`;
}
function demoChatChip(chat) {
  return chat.demo === true ? chip("Örnek sohbet", "amber") : "";
}
function chatList(data) {
  const rows = data.items.map((c) => `<li><a class="chatRow" href="${esc(workshopHref(offset, c.workspace_id, c.chat_id))}">
    <span class="chatIdentity"><span class="chatListIcon">${icon("chat", 17)}</span><span><span class="chatIdentityTitle"><strong>Sohbet ${esc(c.chat_id)}</strong>${demoChatChip(c)}</span><small>Çalışma alanı · ${esc(c.workspace_id)}</small></span></span>
    <span><span class="chatMobileLabel">Başlatan</span>${esc(c.initiator || "Bilinmiyor")}</span>
    <span><span class="chatMobileLabel">Başlangıç</span>${esc(chatTime(c.started_at))}</span>
    <span><span class="chatMobileLabel">Son etkinlik</span>${esc(chatTime(c.updated_at))}</span>
    <span class="chatGo">${icon("chevron", 15)}</span></a></li>`).join("");
  const total = data.total;
  const next = offset + chatPageSize, prev = Math.max(0, offset - chatPageSize);
  const pageLink = (label, start, enabled) => enabled
    ? `<a class="btn" href="${esc(workshopHref(start))}">${label}</a>`
    : `<button class="btn" disabled>${label}</button>`;
  const connection = data.connected === true ? chip("Veri kaynağı bağlı", "green")
    : data.connected === false ? chip("Veri kaynağı bağlı değil", "amber") : chip("Bağlantı bilinmiyor");
  return `<section class="panel chatList"><div class="panelHead"><h2>Sohbetler <span class="pillCount">${num(total)}</span></h2>${connection}</div>
    ${rows ? `<div class="chatColumns" aria-hidden="true"><span>SOHBET / ÇALIŞMA ALANI</span><span>BAŞLATAN</span><span>BAŞLANGIÇ</span><span>SON ETKİNLİK</span></div><ul class="chatRows">${rows}</ul>`
    : `<div class="empty">${icon("chat", 24)}<strong>${data.connected === false ? "Workshop verisi bağlı değil" : offset ? "Bu sayfada sohbet yok" : "Henüz sohbet kaydı yok"}</strong></div>`}
    <div class="footerRow"><span>${rows ? num(offset + 1) + "–" + num(offset + data.items.length) + " / " + num(total) : "0 kayıt"}</span>
    <nav class="toolbar" aria-label="Sohbet sayfaları">${pageLink("Önceki", prev, offset > 0)}${pageLink("Sonraki", next, next < total)}</nav></div></section>`;
}
const chatEventTypes = {
  start: ["Sohbet başlangıcı", "play"], model: ["Model çağrısı", "activity"],
  tool: ["Araç çağrısı", "code"], approval: ["Onay kararı", "check"], guard: ["Guard model çağrısı", "shield"],
};
const chatStatuses = {
  started: ["Başladı", "blue"], requested: ["Talep edildi", "blue"],
  executed: ["Çalıştırıldı", "green"], success: ["Başarılı", "green"], completed: ["Tamamlandı", "green"],
  failed: ["Başarısız", "red"], aborted: ["İptal edildi", ""],
  blocked: ["Engellendi", "red"], not_called: ["Modele iletilmedi", "amber"], pending: ["Karar bekliyor", "amber"],
  approved: ["Onaylandı", "green"], denied: ["Reddedildi", "red"], auto_approved: ["Otomatik onay", "blue"],
  http_ok: ["HTTP başarılı", "green"], http_error: ["HTTP hatası", "red"], ...decisionNames,
};
function chatMoney(value) {
  return Number(value).toLocaleString("tr-TR", { maximumSignificantDigits: 9 }) + " USD";
}
function chatEvent(event) {
  const type = Object.hasOwn(chatEventTypes, event.type) ? event.type : "";
  const [kind, symbol] = chatEventTypes[type] || ["Olay", "circle"];
  const label = type === "tool" && event.status === "requested" ? "Araç talebi" : kind;
  const fields = [];
  if (type === "approval") {
    if (event.status === "auto_approved") fields.push(["Kuralı açan", event.actor || "Bilinmiyor"]);
    else if (event.status !== "pending") {
      const role = event.status === "approved" ? "Onaylayan" : event.status === "denied" ? "Reddeden" : "Kararı veren";
      fields.push([role, event.actor || "Bilinmiyor"]);
    }
  } else if (event.actor) {
    fields.push([type === "start" ? "Başlatan" : "Aktör", event.actor]);
  }
  if (event.operation)
    fields.push([type === "guard" ? "Aşama" : "İşlem", Object.hasOwn(stageNames, event.operation) ? stageNames[event.operation] : event.operation]);
  const modelCall = type === "model" || type === "guard";
  if (modelCall) {
    if (event.requested_model) fields.push(["İstenen model", event.requested_model]);
    if (event.served_model) fields.push(["Yanıtı veren model", event.served_model]);
    if (event.http_status != null) fields.push(["HTTP", event.http_status]);
    if (event.input_tokens != null || event.output_tokens != null) {
      fields.push(["Giriş tokenı", num(event.input_tokens)], ["Çıkış tokenı", num(event.output_tokens)]);
    } else fields.push(["Token kullanımı", "Bilinmiyor"]);
    if (event.cached_tokens != null) fields.push(["Önbellek tokenı", num(event.cached_tokens)]);
    fields.push([event.cost_source === "workshop_estimate" ? "Katalog tahmini" : "Maliyet",
      event.cost_usd == null ? "Bilinmiyor" : chatMoney(event.cost_usd)]);
  }
  if (event.request_id) fields.push(["İstek", event.request_id]);
  const metadata = fields.map(([key, val]) => `<div><dt>${esc(key)}</dt><dd>${esc(val)}</dd></div>`).join("");
  const status = event.status == null || event.status === "" ? ""
    : Object.hasOwn(chatStatuses, event.status) ? chip(...chatStatuses[event.status]) : chip("Durum bilinmiyor");
  const link = event.trace_id && event.trace_available !== false ? `<a class="chatTrace" href="${esc(traceHref(event.trace_id))}">${icon("link", 13)} İstek izi</a>` : "";
  return `<li class="chatEvent"><span class="chatEventIcon ${type}">${icon(symbol, 15)}</span>
    <div class="chatEventBody"><div class="chatEventHead"><h3>${label}</h3>${status}<time>${esc(chatTime(event.ts))}</time></div>
    ${event.name || modelCall ? `<div class="chatEventName">${esc(event.name || event.served_model || event.requested_model || "Model adı bilinmiyor")}</div>` : ""}
    ${metadata ? `<dl class="chatEventMeta">${metadata}</dl>` : ""}${link}</div></li>`;
}
function chatDetail(c) {
  const events = c.events;
  const knownCost = c.cost_usd != null;
  const estimated = events.some((event) => event.cost_usd != null && event.cost_source === "workshop_estimate");
  const costLabel = knownCost && !c.cost_complete ? "Bilinen maliyet" : estimated ? "Tahmini toplam" : "Toplam maliyet";
  const priceStatus = c.cost_complete ? "Tümü fiyatlandı" : "Kısmi toplam";
  const counts = [c.priced == null ? "" : num(c.priced) + " fiyatlanan çağrı",
    c.unpriced == null ? "" : num(c.unpriced) + " fiyatı bilinmeyen çağrı",
    estimated && !c.cost_complete ? "Katalog tahmini içerir" : ""].filter(Boolean);
  return `${chatBack()}<div class="chatSummary">
    <section class="chatInfo"><div class="chatInfoTitle">${icon("chat", 17)}<h2>Sohbet kimliği</h2>${demoChatChip(c)}</div><code>${esc(c.chat_id)}</code>
    <dl><div><dt>Çalışma alanı</dt><dd>${esc(c.workspace_id)}</dd></div><div><dt>Başlatan</dt><dd>${esc(c.initiator || "Bilinmiyor")}</dd></div><div><dt>Başlangıç</dt><dd>${esc(chatTime(c.started_at))}</dd></div><div><dt>Son etkinlik</dt><dd>${esc(chatTime(c.updated_at))}</dd></div></dl></section>
    <section class="panel chatCost"><h2>${costLabel}</h2><strong>${knownCost ? chatMoney(c.cost_usd) : "Bilinmiyor"}</strong>
    <div>${knownCost ? chip(priceStatus, c.cost_complete ? "green" : "amber") : ""}${counts.length ? `<span>${esc(counts.join(" · "))}</span>` : ""}</div>
    ${c.cost_complete === false && c.coverage_note ? `<p class="chatCoverage">${esc(c.coverage_note)}</p>` : ""}</section></div>
    <section class="panel chatHistory"><div class="panelHead"><h2>Sohbet akışı <span class="pillCount">${num(events.length)}</span></h2></div>
    ${events.length ? `<ol class="chatEvents">${events.map(chatEvent).join("")}</ol>` : `<div class="empty">${icon("clock", 24)}<strong>Bu sohbette henüz olay yok</strong></div>`}</section>`;
}
function workshopView() {
  const detail = Boolean(workspaceId || chatId);
  if (!workshopResult)
    return `${detail ? chatBack() : ""}<section class="panel empty" role="status">${detail ? "Sohbet akışı yükleniyor…" : "Sohbetler yükleniyor…"}</section>`;
  if (workshopResult.error)
    return `${detail ? chatBack() : ""}<div class="panel empty" role="status">${icon("circle", 24)}<strong>${esc(workshopResult.error)}</strong>${btn("refresh", "Tekrar dene", "refresh")}</div>`;
  return detail ? chatDetail(workshopResult.data) : chatList(workshopResult.data);
}
function render() {
  if (!info) return;
  const focused = document.activeElement;
  let focusSelector;
  if ($("#content").contains(focused)) {
    if (focused.id) focusSelector = "#" + CSS.escape(focused.id);
    else {
      for (const attr of ["data-event", "data-a", "href"]) {
        if (focused.hasAttribute(attr)) {
          focusSelector = "[" + attr + "=" + CSS.escape(focused.getAttribute(attr)) + "]";
          break;
        }
      }
    }
  }
  const selection = focused.id === "query" ? [focused.selectionStart, focused.selectionEnd] : null;
  const views = {
    overview: () =>
      `${kpis()}<div class="overviewGrid">${chart()}${compactSources()}</div>${table("Son olaylar", true)}`,
    logs: () => filters() + table("Olaylar"),
    gateway: gatewayView,
    workshop: workshopView,
    host: hostView,
    sources: tiles,
  };
  $("#content").innerHTML =
    (netError ? `<div class="alert">${esc(netError)}</div>` : "") +
    views[page]();
  $("#content").setAttribute("aria-busy", "false");
  const nextFocus = focusSelector && $("#content").querySelector(focusSelector);
  if (nextFocus) {
    nextFocus.focus({ preventScroll: true });
    if (selection) nextFocus.setSelectionRange(...selection);
  }
  $("#sideHost").textContent = info.host.name;
  $("#sideStatus").textContent = netError
    ? "Bağlantı kesildi"
    : "● Yerel sunucu";
  $("#fresh").textContent = "Son güncelleme " + time(info.now, true);
  const plot = $("#plot");
  if (plot)
    plot.onpointermove = (e) => {
      const values = info.series;
      if (!values.length) return;
      const b = plot.getBoundingClientRect();
      const n = Math.round(
        Math.max(
          0,
          Math.min(1, (e.clientX - b.left - b.width * 0.05) / (b.width * 0.94)),
        ) *
          (values.length - 1),
      );
      const v = values[n];
      const tip = plot.querySelector(".plotTip");
      tip.textContent = `${time(v.ts, true)} · CPU %${num(v.cpu, 1)} · RAM %${num(v.ram, 1)}`;
      tip.style.display = "block";
      plot.onpointerleave = () => (tip.style.display = "none");
    };
}
async function refresh() {
  const token = ++version,
    p = page;
  try {
    const params = new URLSearchParams({
      since: Math.floor(Date.now() - range * 1000),
      limit: p === "overview" ? 7 : pageSize,
      offset: p === "overview" ? 0 : offset,
    });
    if (p === "gateway" && traceId) {
      params.delete("since");
      params.set("trace_id", traceId);
      params.set("order", "asc");
    } else if (p === "gateway") {
      params.set("source", gatewayTab === "policy" ? "policy" : "gateway");
      if (gatewayTab === "policy" && decision) params.set("kind", decision);
      if (gatewayTab === "policy" && stage) params.set("operation", stage);
    }
    if (p === "logs" && source) params.set("source", source);
    if (p === "logs" || p === "gateway") {
      if (search) params.set("q", search);
      if (severity) params.set("level", severity);
    }
    const [snapshot, events, workshop] = await Promise.all([
      api("/api/overview?range=" + range),
      ["overview", "logs", "gateway"].includes(p)
        ? api("/api/events?" + params)
        : Promise.resolve({ items: [], total: 0 }),
      p === "workshop" ? loadWorkshop() : null,
    ]);
    if (token !== version) return;
    info = snapshot;
    eventPage = events;
    workshopResult = workshop;
    netError = "";
    updateHead();
    render();
  } catch {
    if (token !== version) return;
    netError = "Sunucuya erişilemiyor. Son alınan veriler gösteriliyor.";
    if (info) render();
    else
      $("#content").innerHTML =
        '<div class="alert">Yerel servise ulaşılamadı. Yenile düğmesiyle tekrar deneyebilirsin.</div>';
  }
}
function navigate() {
  const [target, query] = location.hash.slice(1).split("?", 2);
  const route = new URLSearchParams(query);
  gatewayTab = route.get("view") === "traffic" ? "traffic" : "policy";
  traceId = target === "gateway" ? route.get("trace") || "" : "";
  workspaceId = target === "workshop" ? route.get("workspace_id") || "" : "";
  chatId = target === "workshop" ? route.get("chat_id") || "" : "";
  workshopResult = null;
  decision = "";
  stage = "";
  $("#drawer").close();
  eventPage = { items: [], total: 0 };
  $("#content").setAttribute("aria-busy", "true");
  page = Object.hasOwn(pages, target) ? target : "overview";
  const requestedOffset = Number(route.get("offset"));
  offset = page === "workshop" && Number.isSafeInteger(requestedOffset) && requestedOffset > 0
    ? Math.floor(requestedOffset / chatPageSize) * chatPageSize : 0;
  if (page === "workshop") $("#content").innerHTML = workshopView();
  source = "";
  search = "";
  severity = "";
  document.body.classList.remove("sidebarOpen");
  nav();
  updateHead();
  refresh();
  window.scrollTo(0, 0);
}
function gotoPage(p) {
  if (location.hash === "#" + p) navigate();
  else location.hash = p;
}
function dialog(label, body) {
  $("#dialogLabel").textContent = label;
  $("#dialogBody").innerHTML = body;
  if (!$("#drawer").open) $("#drawer").showModal();
}
function configDialog() {
  const cfg = info.settings;
  dialog(
    "MODEL GATEWAY",
    `<h2>Bağlantı ayarları</h2><p class="copyText">Model istemcinin API kökünü <code>${esc(info.publicGatewayUrl || location.origin + "/v1")}</code> olarak ayarla. Halkness çağrıları aşağıdaki sağlayıcıya iletir.</p><form id="configForm"><label class="formField">Sağlayıcının API kökü<input id="endpoint" type="url" placeholder="https://api.openai.com/v1" value="${esc(cfg.upstream)}"></label><div class="copyText">Anahtar gerektiren sağlayıcılar için servis ortamında <code>SEYIR_UPSTREAM_KEY</code> kullanılır. ${info.keyReady === null ? "Sağlayıcı anahtarı gateway sürecinde yönetilir." : info.keyReady ? "Kayıtlı adres için sağlayıcı anahtarı tanımlı." : "Kayıtlı adres için sağlayıcı anahtarı tanımlı değil."}</div><label class="formField">Dakikalık istek sınırı<input id="rateLimit" type="number" min="0" max="100000" value="${cfg.rate}" required></label><small class="muted">0 sınırı kapatır. Tüm istemciler aynı pencereyi paylaşır.</small><div class="actions">${btn("cancel", "İptal")}<button class="btn primary" type="submit">Kaydet</button></div><div id="cfgErr" role="alert"></div></form>`,
  );
  $("#configForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upstream: $("#endpoint").value,
          rate: Number($("#rateLimit").value),
        }),
      });
      $("#drawer").close();
      await refresh();
      toast("Gateway ayarları kaydedildi.");
    } catch (err) {
      $("#cfgErr").textContent = err.message;
    }
  };
}
async function policyDialog() {
  dialog("KORUMA AYARLARI", '<p id="loadingPolicy" class="copyText" role="status">Güncel ayarlar alınıyor…</p>');
  const loading = $("#loadingPolicy");
  let cfg;
  try {
    cfg = await api("/api/settings");
  } catch (err) {
    if (loading.isConnected) loading.textContent = err.message;
    return;
  }
  if (!loading.isConnected || !$("#drawer").open) return;
  dialog("AI GATEWAY", `<h2>Koruma ayarları</h2><form id="policyForm">
    <section class="policyFields"><h3>Yerel DLP</h3>
      <label class="checkline"><input type="checkbox" name="dlp" ${cfg.dlp ? "checked" : ""}>Kart numaralarını ve bilinen API anahtarı biçimlerini denetle</label>
    </section>
    <section class="policyFields"><h3>Guard modeli</h3>
      <label class="formField">Guard API kökü<input type="url" name="guardRoot" aria-describedby="guardHelp" value="${esc(cfg.guardRoot)}" placeholder="http://localhost:8000/v1"></label>
      <p class="fieldHelp" id="guardHelp">OpenAI uyumlu servis adresi. Boş bıraktığında Guard denetimi kapanır.</p>
      <label class="formField">Model kimliği<input name="guardModel" maxlength="140" value="${esc(cfg.guardModel || defaultGuardModel)}" placeholder="${defaultGuardModel}"></label>
      <label class="formField">Model Unsafe kararı verdiğinde<select name="guardAction"><option value="block" ${cfg.guardAction !== "flag" ? "selected" : ""}>Engelle</option><option value="flag" ${cfg.guardAction === "flag" ? "selected" : ""}>İşaretle ve geçir</option></select></label>
      <p class="fieldHelp">Controversial kararında içerik işaretlenerek geçer.</p>
      <p class="fieldHelp">${info.guardKeyReady === null ? "Guard anahtarı gateway sürecinde yönetilir." : info.guardKeyReady ? "Kayıtlı adres için Guard anahtarı tanımlı." : "Kayıtlı adres için Guard anahtarı tanımlı değil."}</p>
    </section>
    <div class="actions"><button type="button" class="btn" data-a="cancel">İptal</button><button class="btn primary" type="submit">Kaydet</button></div>
    <p id="policyError" role="alert"></p></form>`);
  const form = $("#policyForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const values = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dlp: values.has("dlp"),
          guardRoot: values.get("guardRoot").trim(),
          guardModel: values.get("guardModel").trim() || defaultGuardModel,
          guardAction: values.get("guardAction"),
        }),
      });
      if (form.isConnected) $("#drawer").close();
      await refresh();
      toast("Koruma ayarları kaydedildi.");
    } catch (err) {
      form.querySelector('[role="alert"]').textContent = err.message;
      submit.disabled = false;
    }
  };
}
function sourceDialog(k) {
  if (k === "gateway") {
    configDialog();
    return;
  }
  const s = info.sources[k];
  const contents = {
    host: `CPU ve RAM yaklaşık 2,5 saniyede bir örneklenir. Disk oranı Halkness veri dizininin bulunduğu birime aittir.`,
    system: `Windows’ta Application ve System kanallarının son altı saatinden erişilebilen kayıtlar alınır. Linux’ta journalctl kullanılır.`,
    files: `Bu dizine .log, .jsonl veya .ndjson dosyası ekle. Yeni satırlar otomatik okunur. Konumu SEYIR_LOG_DIR ile değiştirebilirsin.`,
    docker: `Halkness, çalışan Docker motorunu CLI üzerinden okur. Görünecek konteynerlerin daemon’u ile aynı Docker bağlamını kullanmalı.`,
    ingest: `Bir uygulama yerel API’ye service, level ve message gönderebilir. Aynı trace_id taşıyan olaylar ayrıntı ekranında birlikte açılır.`,
  };
  const sample =
    k === "files"
      ? info.host.logsDir
      : k === "ingest"
        ? `POST ${location.origin}/api/events\nContent-Type: application/json\n\n{"service":"web","level":"info","message":"İş tamamlandı","trace_id":"tur-01"}`
        : "";
  dialog(
    "VERİ KAYNAĞI",
    `<h2>${esc(s?.name || "Uygulama olayları")}</h2>${stateChip(s?.state || "ready")}<p class="copyText">${contents[k]}</p>${sample ? `<pre class="code">${esc(sample)}</pre>` : ""}${s ? `<p class="copyText">${esc(s.note)}</p>` : ""}`,
  );
}
async function eventDetail(id) {
  const row = eventPage.items.find((e) => e.id === id);
  if (!row) return;
  const traceLink = row.trace_id && !traceId
    ? `<a class="btn traceLink" href="${esc(traceHref(row.trace_id))}">${icon("link", 15)} İstek izini aç</a>`
    : "";
  if (row.source === "policy") {
    dialog("KORUMA KARARI", `${policyBadge(row.kind)}<h2>${esc(row.message)}</h2>${keyVal([
      ["Zaman", day(row.ts) + " " + time(row.ts, true)],
      ["Aşama", stageNames[row.operation] || row.operation],
      ["Denetleyici", row.service],
      ["Örnek kaynağı", fixtureLabel(row.service)],
      ["Kural / gerekçe", row.detail],
      ["Model", row.model],
      ["Süre", row.duration == null ? "" : num(row.duration) + " ms"],
      ["İstek kimliği", row.request_id],
      ["İz kimliği", row.trace_id],
    ])}${traceLink}`);
    return;
  }
  dialog(
    "OLAY AYRINTISI",
    `${levelChip(row.level)}<h2>${esc(row.message)}</h2>${keyVal([
      ["Zaman", day(row.ts) + " " + time(row.ts, true)],
      ["Servis", row.service],
      ["Kaynak", sourceNames[row.source] || row.source],
      ["Olay türü", row.kind],
      ["İşlem kaynağı", row.operation],
      ["HTTP", row.status],
      ["Süre", row.duration == null ? "" : num(row.duration) + " ms"],
      ["İstenen model", row.model],
      ["Ana model çağrısı", row.source === "gateway" ? (row.upstream_called == null ? "Ölçülmedi" : row.upstream_called ? "Yapıldı" : "Yapılmadı") : ""],
      ["Çalışan model", row.served_model],
      ["Giriş tokenı", row.input_tokens],
      ["Çıkış tokenı", row.output_tokens],
      ["Önbellek tokenı", row.cached_tokens],
      ["Tahmini maliyet", row.cost_usd == null ? null : money(row.cost_usd)],
      ["İstek kimliği", row.request_id],
      ["İz kimliği", row.trace_id],
      ["Ayrıntı", row.detail],
    ])}${traceLink}<div id="traceRows"></div>`,
  );
  if (row.trace_id && !traceId) {
    const dest = $("#traceRows");
    try {
      const result = await api(
        "/api/events?limit=100&trace_id=" + encodeURIComponent(row.trace_id),
      );
      if (!dest.isConnected || result.total < 2) return;
      const { trace, items } = result;
      dest.innerHTML = `<h3 class="sectionTitle">Aynı izdeki olaylar (${num(trace.events)})</h3>
        ${keyVal([
          ["Gateway isteği", trace.requests],
          ["Ana model çağrısı", num(trace.upstream_calls)],
          ["Tarifesi hesaplanan çağrı", trace.priced],
          ["Hesaplanan toplam", money(trace.cost_usd)],
        ])}
        ${items.length < trace.events ? "<p>En son 100 olay gösteriliyor.</p>" : ""}
        ${items
          .reverse()
          .map(
            (e) =>
              `<p class="copyText">${time(e.ts, true)} · ${esc(e.operation || e.service)} · ${esc(e.served_model || e.message)}${e.cost_usd == null ? "" : " · " + money(e.cost_usd)}</p>`,
          )
          .join("")}`;
    } catch {
      dest.textContent = "İlgili olaylar alınamadı.";
    }
  }
}
for (const el of document.querySelectorAll("[data-icon]"))
  el.innerHTML = icon(el.dataset.icon, 17);
$("#dismiss").onclick = () => $("#drawer").close();
$("#drawer").onclick = (e) => {
  if (e.target === $("#drawer")) $("#drawer").close();
};
$("#menu").onclick = () => document.body.classList.toggle("sidebarOpen");
$("#scrim").onclick = () => document.body.classList.remove("sidebarOpen");
function focusSearch() {
  gotoPage("logs");
  const focus = () => $("#query")?.focus();
  setTimeout(focus, 120);
  setTimeout(focus, 320);
}
$("#search").onclick = focusSearch;
document.addEventListener("keydown", (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "k" &&
    !$("#drawer").open
  ) {
    e.preventDefault();
    focusSearch();
  }
  if (
    (e.key === "Enter" || e.key === " ") &&
    e.target.matches("tr[data-event]")
  ) {
    e.preventDefault();
    eventDetail(Number(e.target.dataset.event));
  }
  if (e.key === "Escape") document.body.classList.remove("sidebarOpen");
});
document.addEventListener("input", (e) => {
  if (e.target.id === "query") {
    search = e.target.value;
    offset = 0;
    clearTimeout(timer);
    timer = setTimeout(refresh, 180);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "range") range = Number(e.target.value);
  else if (e.target.id === "source") source = e.target.value;
  else if (e.target.id === "severity") severity = e.target.value;
  else if (e.target.id === "decision") decision = e.target.value;
  else if (e.target.id === "stage") stage = e.target.value;
  else return;
  offset = 0;
  refresh();
});
document.addEventListener("click", (e) => {
  const tr = e.target.closest("[data-event]");
  if (tr) {
    eventDetail(Number(tr.dataset.event));
    return;
  }
  const a = e.target.closest("[data-a]")?.dataset.a;
  if (!a) return;
  if (Object.hasOwn(pages, a)) gotoPage(a);
  else if (a === "traffic") gotoPage("gateway?view=traffic");
  else if (a === "policy-config") policyDialog();
  else if (a === "refresh") refresh();
  else if (a === "live") {
    live = !live;
    updateHead();
    if (live) refresh();
    else render();
  } else if (a === "prev" || a === "next") {
    offset = Math.max(0, offset + (a === "prev" ? -pageSize : pageSize));
    refresh();
  } else if (a === "prices") pricesDialog();
  else if (a === "config") configDialog();
  else if (a === "cancel") {
    e.preventDefault();
    $("#drawer").close();
  } else if (a.startsWith("detail-")) sourceDialog(a.slice(7));
});
window.addEventListener("hashchange", navigate);
navigate();
setInterval(() => {
  if (
    live &&
    !document.hidden &&
    !$("#drawer").open &&
    !["query", "range", "source", "severity", "decision", "stage"].includes(
      document.activeElement?.id,
    )
  )
    refresh();
}, 5000);
function pricesDialog() {
  const prices = [...info.settings.prices];
  const row = (p) =>
    `<fieldset class="priceRow"><label>Model kimliği<input class="priceModel" required maxlength="140" value="${esc(p.model)}" placeholder="Sağlayıcının döndürdüğü model"></label><div class="pricesGrid">${[
      ["input", "Giriş"],
      ["cached", "Önbellek"],
      ["output", "Çıkış"],
    ]
      .map(
        ([k, n]) =>
          `<label>${n}<input class="price-${k}" type="number" min="0" step="any" required value="${esc(p[k])}"></label>`,
      )
      .join(
        "",
      )}</div><button class="linkButton removePrice" type="button">Tarifeyi kaldır</button></fieldset>`;
  dialog(
    "MODEL GATEWAY",
    `<h2>Model tarifeleri</h2><p class="copyText">Bir milyon token başına USD fiyatlarını gir. Halkness tamamlanan çağrıda geçerli tarifeyi saklar. Tarifesi olmayan modelin bedeli belirsiz görünür.</p><form id="pricesForm"><div id="priceRows">${prices.map(row).join("")}</div><button type="button" id="addPrice" class="btn">Tarife ekle</button><div class="actions"><button type="button" class="btn" data-a="cancel">İptal</button><button class="btn primary">Kaydet</button></div><p id="priceError" role="alert"></p></form>`,
  );
  $("#addPrice").onclick = () =>
    $("#priceRows").insertAdjacentHTML(
      "beforeend",
      row({ model: "", input: "", cached: "", output: "" }),
    );
  $("#priceRows").onclick = (e) => {
    if (e.target.closest(".removePrice")) e.target.closest("fieldset").remove();
  };
  $("#pricesForm").onsubmit = async (e) => {
    e.preventDefault();
    const items = Array.from(document.querySelectorAll(".priceRow"), (node) => {
      const item = { model: node.querySelector(".priceModel").value.trim() };
      for (const key of ["input", "cached", "output"])
        item[key] = Number(node.querySelector(".price-" + key).value);
      return item;
    });
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prices: items }),
      });
      $("#drawer").close();
      await refresh();
      toast("Model tarifeleri kaydedildi.");
    } catch (err) {
      $("#priceError").textContent = err.message;
    }
  };
}
