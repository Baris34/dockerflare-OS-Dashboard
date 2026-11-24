// Only fixed rules and parsed model labels leave this module as audit details.
import { usageCost } from "./store.mjs";
const categories = new Set([
  "Violent",
  "Non-violent Illegal Acts",
  "Sexual Content or Sexual Acts",
  "PII",
  "Suicide & Self-Harm",
  "Unethical Acts",
  "Politically Sensitive Topics",
  "Copyright Violation",
  "Jailbreak",
  "None",
]);
const maxOutput = 4 * 1024 * 1024;
const maxGuardInput = 192 * 1024;

export class PolicyError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function formatError() {
  throw new Error("format");
}
function string(value) {
  if (typeof value !== "string") formatError();
  return value;
}
function supported(obj, keys) {
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.keys(obj).some((k) => !keys.includes(k))
  )
    formatError();
}
function emptyList(value) {
  if (value != null && (!Array.isArray(value) || value.length !== 0))
    formatError();
}
function identifiers(obj, keys) {
  for (const key of keys)
    if (obj[key] != null && !auditIdentifier(obj[key], null, 256))
      formatError();
}

function dlpRule(text) {
  if (
    /\b(?:sk-(?:proj-|svcacct-|ant-)?[\w-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|glpat-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[\w-]{12,})\b/.test(
      text,
    ) ||
    /\bBearer[ \t]+[A-Za-z0-9+/_=.~-]{12,}/i.test(text) ||
    /\b(?:api[-_]?key|access[-_]?token|client[-_]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9/_+=.~-]{16,}/i.test(
      text,
    ) ||
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(
      text,
    )
  )
    return "API erişim bilgisi";
  for (const [match] of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match.replace(/\D/g, "");
    if (/^(\d)\1+$/.test(digits)) continue;
    let sum = 0,
      twice = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]) * (twice ? 2 : 1);
      sum += n > 9 ? n - 9 : n;
      twice = !twice;
    }
    if (sum % 10 === 0) return "Kart numarası (Luhn)";
  }
  return "";
}
export function auditIdentifier(value, fallback, limit) {
  return typeof value === "string" &&
    value.length <= limit &&
    /^[\p{L}\p{N}_./:@+-]+$/u.test(value) &&
    !dlpRule(value)
    ? value
    : fallback;
}

function textParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) formatError();
  return content
    .map((part) => {
      if (part?.type === "refusal") {
        supported(part, ["type", "refusal"]);
        return string(part.refusal);
      }
      if (!["text", "input_text", "output_text"].includes(part?.type))
        formatError();
      supported(part, ["type", "text", "annotations", "logprobs"]);
      emptyList(part.annotations);
      emptyList(part.logprobs);
      return string(part.text);
    })
    .join("");
}
function functionText(fn) {
  supported(fn, ["name", "arguments"]);
  const args = string(fn.arguments);
  let decoded;
  try {
    decoded = JSON.stringify(JSON.parse(args));
  } catch {
    /* Some providers emit plain arguments. */
  }
  return (
    "Function " +
    string(fn.name) +
    "\n" +
    args +
    (decoded && decoded !== args ? "\n" + decoded : "")
  );
}
function messageText(msg) {
  supported(msg, [
    "role",
    "name",
    "content",
    "refusal",
    "reasoning_content",
    "reasoning",
    "tool_calls",
    "function_call",
    "tool_call_id",
    "annotations",
  ]);
  emptyList(msg.annotations);
  identifiers(msg, ["name", "tool_call_id"]);
  const parts = [];
  if (msg.content != null) parts.push(textParts(msg.content));
  for (const key of ["reasoning", "reasoning_content", "refusal"])
    if (msg[key] != null) parts.push(string(msg[key]));
  if (msg.function_call) parts.push(functionText(msg.function_call));
  for (const call of msg.tool_calls ?? []) {
    supported(call, ["id", "type", "function"]);
    identifiers(call, ["id"]);
    if (call.type && call.type !== "function") formatError();
    parts.push(functionText(call.function));
  }
  if (!parts.length) formatError();
  return parts.join("\n");
}
function responseItem(item) {
  identifiers(item, ["id", "call_id", "status", "phase"]);
  if (item?.type === "function_call") {
    supported(item, ["type", "id", "status", "call_id", "name", "arguments"]);
    return {
      role: "assistant",
      content: functionText({ name: item.name, arguments: item.arguments }),
    };
  }
  if (item?.type === "function_call_output") {
    supported(item, ["type", "id", "status", "call_id", "output"]);
    return { role: "user", content: "Tool result\n" + textParts(item.output) };
  }
  if (item?.type && item.type !== "message") formatError();
  supported(item, ["id", "type", "role", "status", "content", "phase"]);
  if (!["user", "system", "assistant", "developer"].includes(item.role))
    formatError();
  return { role: item.role, content: textParts(item.content) };
}
export function policyInput(data, isResponses) {
  // Prior conversation or encrypted/media inputs unavailable to a text guard cannot be inspected.
  const common = [
    "model",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "stream",
    "stream_options",
    "metadata",
    "store",
    "user",
    "service_tier",
    "safety_identifier",
    "prompt_cache_key",
    "prompt_cache_retention",
  ];
  const apiFields = isResponses
    ? [
        "input",
        "instructions",
        "text",
        "reasoning",
        "max_output_tokens",
        "max_tool_calls",
        "truncation",
        "include",
        "previous_response_id",
        "conversation",
        "prompt",
        "background",
        "top_logprobs",
      ]
    : [
        "messages",
        "n",
        "max_tokens",
        "max_completion_tokens",
        "frequency_penalty",
        "presence_penalty",
        "stop",
        "seed",
        "response_format",
        "functions",
        "function_call",
        "reasoning_effort",
        "verbosity",
        "audio",
        "modalities",
        "prediction",
        "logit_bias",
        "logprobs",
        "top_logprobs",
      ];
  supported(data, [...common, ...apiFields]);
  if (
    data.previous_response_id ||
    data.conversation ||
    data.prompt ||
    data.audio ||
    data.modalities?.some((m) => m !== "text") ||
    data.background
  )
    formatError();
  if (
    data.tools?.some((tool) => tool?.type !== "function") ||
    (data.n != null && (!Number.isInteger(data.n) || data.n < 1 || data.n > 8))
  )
    formatError();
  const context = [];
  if (data.instructions != null) context.push(string(data.instructions));
  for (const key of [
    "tools",
    "functions",
    "tool_choice",
    "function_call",
    "response_format",
    "text",
    "metadata",
    "prediction",
  ]) {
    if (data[key] != null) context.push(JSON.stringify(data[key]));
  }
  const history = context.length
    ? [{ role: "user", content: context.join("\n") }]
    : [];
  if (isResponses) {
    if (typeof data.input === "string")
      history.push({ role: "user", content: data.input });
    else if (Array.isArray(data.input))
      history.push(...data.input.map(responseItem));
    else formatError();
  } else {
    for (const msg of data.messages) {
      if (
        ![
          "user",
          "developer",
          "system",
          "assistant",
          "tool",
          "function",
        ].includes(msg?.role)
      )
        formatError();
      let content = messageText(msg);
      if (["function", "tool"].includes(msg.role))
        content = "Tool result\n" + content;
      history.push({ role: msg.role, content });
    }
  }
  // The official template evaluates the last role; it skips tool/developer and initial assistant roles.
  const messages = history.map(({ role, content }, i) => ({
    role: role === "assistant" && i > 0 ? "assistant" : "user",
    content,
  }));
  if (!messages.length) formatError();
  if (messages.at(-1).role !== "user") {
    const last = messages.at(-1);
    last.role = "user";
    last.content = "Assistant prefill\n" + last.content;
  }
  return { messages, raw: JSON.stringify(data) };
}

async function readLimited(stream, limit) {
  if (!stream) formatError();
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("size");
    parts.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}
function parseVerdict(text, output) {
  const lines = string(text).trim().split(/\r?\n/);
  const label = /^Safety: (Safe|Unsafe|Controversial)$/.exec(lines[0])?.[1];
  if (
    !label ||
    lines.length !== (output ? 3 : 2) ||
    !lines[1].startsWith("Categories: ")
  )
    formatError();
  const names = lines[1]
    .slice(12)
    .split(",")
    .map((s) => s.trim());
  if (
    names.some((s) => !categories.has(s) || (output && s === "Jailbreak")) ||
    new Set(names).size !== names.length ||
    (label === "Safe"
      ? names.length !== 1 || names[0] !== "None"
      : names.includes("None"))
  )
    formatError();
  if (output && !/^Refusal: (Yes|No)$/.test(lines[2])) formatError();
  return {
    label,
    detail: [label, ...names, ...(output ? [lines[2]] : [])].join(" · "),
  };
}
async function classify(messages, config, signal, port, output, charge) {
  const url = new URL(config.guardRoot + "/chat/completions");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      +url.port === port)
  )
    throw new Error("address");
  const headers = {
    "content-type": "application/json",
    "x-seyir-policy-hop": "1",
  };
  if (
    process.env.SEYIR_GUARD_KEY &&
    url.origin === process.env.SEYIR_GUARD_KEY_ORIGIN
  )
    headers.authorization = "Bearer " + process.env.SEYIR_GUARD_KEY;
  const body = JSON.stringify({
    model: config.guardModel || "Qwen/Qwen3Guard-Gen-4B",
    messages,
    temperature: 0,
    max_tokens: 128,
    stream: false,
  });
  if (Buffer.byteLength(body) > maxGuardInput) throw new Error("size");
  const started = Date.now();
  let response, data;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (
      !response.ok ||
      !/\bapplication\/json\b/i.test(response.headers.get("content-type") || "")
    ) {
      await response.body?.cancel();
      throw new Error("service");
    }
    data = JSON.parse(await readLimited(response.body, 16384));
    if (
      data.error ||
      data.choices?.length !== 1 ||
      data.choices[0].message?.tool_calls ||
      (data.choices[0].message?.role != null &&
        data.choices[0].message.role !== "assistant") ||
      (data.choices[0].finish_reason != null &&
        data.choices[0].finish_reason !== "stop")
    )
      formatError();
    return parseVerdict(data.choices[0].message?.content, output);
  } finally {
    if (charge) {
      const model =
        auditIdentifier(data?.model, null, 140) || config.guardModel;
      const input = data?.usage?.prompt_tokens,
        out = data?.usage?.completion_tokens;
      charge({
        ts: started,
        status: response?.status ?? 0,
        model,
        upstream_called: 1,
        served_model: auditIdentifier(data?.model, null, 140),
        cached_tokens: Number.isSafeInteger(
          data?.usage?.prompt_tokens_details?.cached_tokens,
        )
          ? data.usage.prompt_tokens_details.cached_tokens
          : null,
        input_tokens: Number.isSafeInteger(input) && input >= 0 ? input : null,
        output_tokens: Number.isSafeInteger(out) && out >= 0 ? out : null,
        cost_usd: usageCost(
          config.prices?.find((p) => p.model === model),
          input,
          out,
          data?.usage?.prompt_tokens_details?.cached_tokens,
        ),
      });
    }
  }
}

export function requestPolicy(config, event, store, signal, localPort, charge) {
  let guardAttempt = 0;
  const services = [];
  if (config.dlp) services.push("dlp");
  if (config.guardRoot) services.push("guard");
  const reported = new Set();
  const names =
    config.fixture === true
      ? { dlp: "DLP · Dockerflare örneği", guard: "Guard test servisi" }
      : { dlp: "DLP", guard: "Qwen3Guard" };
  const actions = {
    allow: "izin verdi",
    block: "engelledi",
    flag: "işaretledi",
    error: "denetleyemedi",
    skip: "denetimi atladı",
  };
  function write(filter, operation, kind, detail, started, model) {
    reported.add(filter + operation);
    store.record({
      source: "policy",
      service: names[filter],
      request_id: event.request_id,
      trace_id: event.trace_id,
      operation,
      kind,
      detail,
      ts: Date.now(),
      duration: Date.now() - started,
      level:
        kind === "error"
          ? "error"
          : ["flag", "block"].includes(kind)
            ? "warn"
            : "info",
      model:
        filter === "guard" && !config.fixture && model
          ? config.guardModel || "Qwen/Qwen3Guard-Gen-4B"
          : null,
      message:
        names[filter] +
        (operation === "input" ? " girişte " : " çıkışta ") +
        actions[kind] +
        ".",
    });
  }
  function skipPending() {
    for (const operation of ["input", "output"])
      for (const filter of services)
        if (!reported.has(filter + operation))
          write(
            filter,
            operation,
            "skip",
            "Önceki adımda durduruldu",
            Date.now(),
          );
  }
  async function check(operation, prepare) {
    let prepared;
    for (const filter of services) {
      const started = Date.now();
      let guardInvoked = false;
      try {
        prepared ??= await prepare();
        let kind = "allow",
          detail;
        if (filter === "dlp") {
          // Include reconstructed deltas and decoded message parts as well as the wire data.
          const rule =
            dlpRule(prepared.raw) ||
            prepared.messages.map((m) => dlpRule(m.content)).find(Boolean);
          if (rule) kind = "block";
          detail = rule || "Kural eşleşmedi";
        } else {
          guardInvoked = true;
          const phaseSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(30000),
          ]);
          let verdict;
          const severity = { Safe: 0, Controversial: 1, Unsafe: 2 };
          for (const messages of prepared.alternatives ?? [prepared.messages]) {
            const result = await classify(
              messages,
              config,
              phaseSignal,
              localPort,
              operation === "output",
              charge &&
                ((row) =>
                  charge(event.request_id, ++guardAttempt, {
                    ...row,
                    operation,
                    trace_id: event.trace_id,
                  })),
            );
            if (!verdict || severity[result.label] > severity[verdict.label])
              verdict = result;
            if (verdict.label === "Unsafe") break;
          }
          kind =
            verdict.label === "Unsafe"
              ? config.guardAction === "flag"
                ? "flag"
                : "block"
              : verdict.label === "Controversial"
                ? "flag"
                : "allow";
          detail = verdict.detail;
        }
        write(filter, operation, kind, detail, started, guardInvoked);
        if (kind === "block")
          throw new PolicyError(
            names[filter] + " politikası engelledi. " + detail,
            filter === "dlp" ? "dlp_block" : "guard_block",
            424,
          );
      } catch (e) {
        if (e instanceof PolicyError) throw e;
        const detail =
          e.message === "size"
            ? "Boyut sınırı aşıldı"
            : guardInvoked
              ? "Sınıflandırma doğrulanamadı"
              : "İçerik güvenle okunamadı";
        write(filter, operation, "error", detail, started, guardInvoked);
        throw new PolicyError(
          detail + ".",
          guardInvoked ? "guard_error" : "policy_error",
          guardInvoked ? 503 : operation === "input" ? 422 : 502,
        );
      }
    }
    return prepared;
  }
  return { active: services.length > 0, check, skipPending };
}

function index(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1024) formatError();
  return value;
}
function chatEnvelope(obj) {
  supported(obj, [
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "system_fingerprint",
    "service_tier",
  ]);
  if (!Array.isArray(obj.choices)) formatError();
  identifiers(obj, [
    "id",
    "object",
    "model",
    "system_fingerprint",
    "service_tier",
  ]);
  if (obj.created != null && !Number.isSafeInteger(obj.created)) formatError();
  if (obj.usage != null) obj.usage = publicUsage(obj.usage);
}
function publicUsage(usage) {
  const result = {};
  if (!usage || typeof usage !== "object" || Array.isArray(usage))
    formatError();
  for (const key of [
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "audio_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
  ]) {
    if (usage[key] != null) {
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) formatError();
      result[key] = usage[key];
    }
  }
  for (const key of [
    "input_tokens_details",
    "output_tokens_details",
    "prompt_tokens_details",
    "completion_tokens_details",
  ]) {
    if (usage[key] != null) result[key] = publicUsage(usage[key]);
  }
  return result;
}
function addDelta(message, delta) {
  supported(delta, [
    "role",
    "content",
    "refusal",
    "reasoning",
    "reasoning_content",
    "function_call",
    "tool_calls",
  ]);
  if (delta.role != null && delta.role !== "assistant") formatError();
  for (const key of ["content", "refusal", "reasoning", "reasoning_content"]) {
    if (delta[key] != null)
      message[key] = (message[key] || "") + string(delta[key]);
  }
  function appendFn(fn, fragment) {
    supported(fragment, ["name", "arguments"]);
    for (const key of ["name", "arguments"])
      if (fragment[key] != null)
        fn[key] = (fn[key] || "") + string(fragment[key]);
  }
  if (delta.function_call)
    appendFn((message.function_call ??= {}), delta.function_call);
  for (const call of delta.tool_calls ?? []) {
    supported(call, ["index", "id", "type", "function"]);
    identifiers(call, ["id"]);
    if (call.type && call.type !== "function") formatError();
    const i = index(call.index);
    const calls = (message.tool_calls ??= []);
    const target = (calls[i] ??= { function: {} });
    if (call.function) appendFn(target.function, call.function);
  }
}

// A Responses envelope may echo the request (instructions, tool descriptions, metadata).
// Keep only the public response fields used by clients, and inspect every returned output item.
function responseEnvelope(obj, texts, partial = false) {
  if (
    !obj ||
    obj.error ||
    ["failed", "incomplete", "cancelled"].includes(obj.status)
  )
    formatError();
  if (!Array.isArray(obj.output)) formatError();
  for (const item of obj.output) {
    if (
      item.type !== "function_call" &&
      (item.type !== "message" || item.role !== "assistant")
    )
      formatError();
    texts.push(responseItem(item).content);
  }
  if (!partial && !obj.output.length) formatError();
  identifiers(obj, ["id", "model", "object", "status"]);
  if (
    (obj.created_at != null && !Number.isSafeInteger(obj.created_at)) ||
    (obj.completed_at != null && !Number.isFinite(obj.completed_at)) ||
    (obj.parallel_tool_calls != null &&
      typeof obj.parallel_tool_calls !== "boolean") ||
    obj.incomplete_details != null
  )
    formatError();
  const response = {};
  for (const key of [
    "id",
    "object",
    "created_at",
    "completed_at",
    "status",
    "model",
    "output",
    "usage",
    "parallel_tool_calls",
    "error",
    "incomplete_details",
  ]) {
    if (obj[key] != null) response[key] = obj[key];
  }
  if (response.usage != null) response.usage = publicUsage(response.usage);
  return response;
}

function parseSse(raw) {
  // Normalize line endings and discard keep-alive comments; never replay an unchecked SSE field.
  const packets = raw.replace(/\r\n?/g, "\n").split(/\n\n+/);
  if (packets.length > 16384) throw new Error("size");
  const frames = [];
  for (const packet of packets) {
    const lines = [],
      fields = packet.split("\n");
    let event = "";
    for (const line of fields) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:") && !event)
        event = line.slice(6).trim();
      else formatError();
    }
    if (!lines.length) {
      if (event) formatError();
      continue;
    }
    const data = lines.join("\n");
    frames.push({ event, value: data === "[DONE]" ? data : JSON.parse(data) });
  }
  return frames;
}
function chatOutput(obj, texts, fragments) {
  chatEnvelope(obj);
  for (const choice of obj.choices) {
    supported(choice, [
      "index",
      fragments ? "delta" : "message",
      "logprobs",
      "finish_reason",
    ]);
    if (choice.index != null) index(choice.index);
    if (
      choice.logprobs != null ||
      (choice.finish_reason != null &&
        ![
          "stop",
          "length",
          "tool_calls",
          "content_filter",
          "function_call",
        ].includes(choice.finish_reason))
    )
      formatError();
    if (fragments) {
      const i = index(choice.index ?? 0);
      if (!fragments.has(i)) fragments.set(i, {});
      addDelta(fragments.get(i), choice.delta);
    } else {
      if (choice.message?.role && choice.message.role !== "assistant")
        formatError();
      texts.push(messageText(choice.message));
    }
  }
}
function responseFrame(frame, texts, deltas) {
  const base = [
    "type",
    "sequence_number",
    "output_index",
    "content_index",
    "item_id",
  ];
  const type = frame?.type;
  identifiers(frame, ["item_id"]);
  for (const field of ["sequence_number", "output_index", "content_index"])
    if (
      frame[field] != null &&
      (!Number.isSafeInteger(frame[field]) || frame[field] < 0)
    )
      formatError();
  switch (type) {
    case "response.created":
    case "response.in_progress":
    case "response.completed":
      supported(frame, [...base, "response"]);
      frame.response = responseEnvelope(
        frame.response,
        texts,
        type !== "response.completed",
      );
      break;
    case "response.output_item.added":
    case "response.output_item.done":
      supported(frame, [...base, "item"]);
      if (!["message", "function_call"].includes(frame.item?.type))
        formatError();
      texts.push(responseItem(frame.item).content);
      break;
    case "response.content_part.added":
    case "response.content_part.done":
      supported(frame, [...base, "part"]);
      texts.push(textParts([frame.part]));
      break;
    case "response.output_text.delta":
    case "response.refusal.delta":
    case "response.function_call_arguments.delta": {
      supported(frame, [...base, "delta", "logprobs"]);
      emptyList(frame.logprobs);
      const key = [
        type,
        index(frame.output_index),
        index(frame.content_index ?? 0),
      ].join("/");
      deltas.set(key, (deltas.get(key) || "") + string(frame.delta));
      break;
    }
    case "response.output_text.done":
    case "response.refusal.done":
    case "response.function_call_arguments.done":
      supported(frame, [
        ...base,
        "text",
        "refusal",
        "arguments",
        "name",
        "logprobs",
      ]);
      emptyList(frame.logprobs);
      if (frame.name) texts.push(string(frame.name));
      texts.push(string(frame.text ?? frame.refusal ?? frame.arguments));
      break;
    default:
      formatError();
  }
}
export async function policyOutput(up, type, isResponses, input, capture) {
  const stream = /^text\/event-stream(?:\s*;|$)/i.test(type);
  if (!stream && !/^application\/json(?:\s*;|$)/i.test(type)) formatError();
  const raw = await readLimited(up, maxOutput);
  const texts = [];
  let wire;
  if (stream) {
    const fragments = new Map(),
      deltas = new Map(),
      packets = [];
    let complete = false,
      sentinel = false;
    for (const { event, value } of parseSse(raw)) {
      if (sentinel) formatError();
      if (value === "[DONE]") {
        if (event) formatError();
        sentinel = true;
        packets.push("data: [DONE]\n\n");
        continue;
      }
      if (complete || (event && (!isResponses || event !== value.type)))
        formatError();
      capture(value);
      if (isResponses) {
        responseFrame(value, texts, deltas);
        complete = value.type === "response.completed";
      } else chatOutput(value, texts, fragments);
      packets.push(
        (event ? "event: " + event + "\n" : "") +
          "data: " +
          JSON.stringify(value) +
          "\n\n",
      );
    }
    if (isResponses ? !complete : !sentinel) formatError();
    for (const message of fragments.values()) texts.push(messageText(message));
    texts.push(...deltas.values());
    wire = packets.join("");
  } else {
    let obj = JSON.parse(raw);
    capture(obj);
    if (isResponses) obj = responseEnvelope(obj, texts);
    else chatOutput(obj, texts);
    wire = JSON.stringify(obj);
  }
  if (!texts.length || !texts.some(Boolean)) formatError();
  const messages = [
    ...input.messages,
    { role: "assistant", content: texts.join("\n") },
  ];
  let alternatives;
  if (!isResponses && texts.length > 1) {
    if (texts.length > 8) formatError();
    alternatives = texts.map((content) => [
      ...input.messages,
      { role: "assistant", content },
    ]);
  }
  return { raw, messages, alternatives, wire };
}
