const DEFAULT_STATE = {
  retries: [{ success: true, runtimeMS: 1 }],
  language: "typescript",
  scheduleToStartTimeout: 0,
  scheduleToCloseTimeout: 0,
  startToCloseTimeout: 10000,
  backoffCoefficient: 2,
  initialInterval: 1000,
  scheduleTime: 0,
  maximumAttempts: 0,
  maximumInterval: 0,
};

const NUMERIC_FIELDS = [
  "scheduleToStartTimeout",
  "scheduleToCloseTimeout",
  "startToCloseTimeout",
  "backoffCoefficient",
  "initialInterval",
  "scheduleTime",
  "maximumAttempts",
  "maximumInterval",
];

const SUPPORTED_LANGUAGES = ["typescript", "go"];

function encodeRetries(retries) {
  return retries
    .map((r) => `${r.success ? "succeed" : "fail"}:${r.runtimeMS}`)
    .join(",");
}

function decodeRetries(raw) {
  const parts = raw.split(",");
  const retries = [];
  for (const part of parts) {
    const [outcome, runtimeRaw] = part.split(":");
    if (outcome !== "succeed" && outcome !== "fail") {
      return null;
    }
    const runtimeMS = Number(runtimeRaw);
    if (!Number.isFinite(runtimeMS)) {
      return null;
    }
    retries.push({ success: outcome === "succeed", runtimeMS });
  }
  return retries.length > 0 ? retries : null;
}

function retriesEqualDefault(retries) {
  const def = DEFAULT_STATE.retries;
  if (retries.length !== def.length) return false;
  for (let i = 0; i < retries.length; ++i) {
    if (retries[i].success !== def[i].success || retries[i].runtimeMS !== def[i].runtimeMS) {
      return false;
    }
  }
  return true;
}

export function encodeStateToParams(state) {
  const params = new URLSearchParams();
  for (const key of NUMERIC_FIELDS) {
    if (state[key] !== DEFAULT_STATE[key]) {
      params.set(key, String(state[key]));
    }
  }
  if (state.language !== DEFAULT_STATE.language) {
    params.set("language", state.language);
  }
  if (!retriesEqualDefault(state.retries)) {
    params.set("retries", encodeRetries(state.retries));
  }
  return params;
}

export function decodeStateFromParams(search) {
  const params = new URLSearchParams(search);
  const out = { ...DEFAULT_STATE };
  for (const key of NUMERIC_FIELDS) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (Number.isFinite(value)) {
      out[key] = value;
    }
  }
  if (params.has("language")) {
    const lang = params.get("language");
    if (SUPPORTED_LANGUAGES.includes(lang)) {
      out.language = lang;
    }
  }
  if (params.has("retries")) {
    const retries = decodeRetries(params.get("retries"));
    if (retries) {
      out.retries = retries;
    }
  }
  return out;
}
