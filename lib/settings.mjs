import { validateRoot } from "./gateway.mjs";

export const defaults = {
  upstream: "",
  rate: 0,
  prices: [],
  dlp: false,
  guardRoot: "",
  guardModel: "Qwen/Qwen3Guard-Gen-4B",
  guardAction: "block",
};

export function readSettings(store) {
  return { ...defaults, ...store.get("settings", {}) };
}

export function mergeSettings(current, patch) {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.keys(patch).length ||
    !Object.keys(patch).every((k) => Object.hasOwn(defaults, k))
  )
    throw new Error("Yalnızca tanımlı ayarlar güncellenebilir.");

  const next = { ...current, ...patch };
  for (const key of ["upstream", "guardRoot"]) {
    if (typeof next[key] !== "string" || next[key].length > 2048)
      throw new Error("Geçersiz API kökü.");
    next[key] = validateRoot(next[key].trim());
  }
  if (
    typeof next.dlp !== "boolean" ||
    !Number.isInteger(next.rate) ||
    next.rate < 0 ||
    next.rate > 100000
  )
    throw new Error("Geçersiz DLP veya hız sınırı ayarı.");
  if (
    typeof next.guardModel !== "string" ||
    !next.guardModel.trim() ||
    /[\x00-\x1f\x7f]/.test(next.guardModel) ||
    next.guardModel.length > 140
  )
    throw new Error("Qwen3Guard model kimliği gerekli.");
  next.guardModel = next.guardModel.trim();
  if (!["block", "flag"].includes(next.guardAction))
    throw new Error("Geçersiz guard eylemi.");
  if (
    !Array.isArray(next.prices) ||
    next.prices.length > 50 ||
    next.prices.some(
      (p) =>
        !p ||
        typeof p.model !== "string" ||
        !p.model.trim() ||
        p.model.length > 140 ||
        ["input", "cached", "output"].some(
          (k) => !Number.isFinite(p[k]) || p[k] < 0,
        ),
    ) ||
    new Set(next.prices.map((p) => p.model)).size !== next.prices.length
  )
    throw new Error(
      "Tarife için benzersiz model adı ve negatif olmayan üç fiyat gerekli.",
    );
  next.prices = next.prices.map(({ model, input, cached, output }) => ({
    model,
    input,
    cached,
    output,
  }));
  return next;
}
