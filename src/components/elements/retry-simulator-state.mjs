// SDK Retry Policy default: Maximum Interval = 100 × Initial Interval.
// (https://docs.temporal.io/encyclopedia/retry-policies#default-values-for-retry-policy)
const MAX_INTERVAL_MULTIPLIER = 100;

const DEFAULT_INITIAL_INTERVAL = 1000;

const DEFAULT_STATE = {
  retries: [{ success: true, runtimeMS: 1 }],
  language: "typescript",
  scheduleToStartTimeout: 0,
  scheduleToCloseTimeout: 0,
  startToCloseTimeout: 10000,
  backoffCoefficient: 2,
  initialInterval: DEFAULT_INITIAL_INTERVAL,
  scheduleTime: 0,
  maximumAttempts: 0,
  maximumInterval: MAX_INTERVAL_MULTIPLIER * DEFAULT_INITIAL_INTERVAL,
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

function defaultMaximumInterval(initialInterval) {
  return MAX_INTERVAL_MULTIPLIER * initialInterval;
}

function fieldDefault(key, state) {
  if (key === "maximumInterval") {
    return defaultMaximumInterval(state.initialInterval);
  }
  return DEFAULT_STATE[key];
}

export function encodeStateToParams(state) {
  const params = new URLSearchParams();
  for (const key of NUMERIC_FIELDS) {
    if (state[key] !== fieldDefault(key, state)) {
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

export function calculateResult(state) {
  const {
    startToCloseTimeout,
    scheduleToCloseTimeout,
    scheduleToStartTimeout,
    scheduleTime,
    initialInterval,
    maximumInterval,
    maximumAttempts,
    backoffCoefficient,
  } = state;

  if (scheduleToStartTimeout > 0 && scheduleTime >= scheduleToStartTimeout) {
    return {
      success: false,
      runtimeMS: scheduleToStartTimeout,
      attempts: 0,
      reason: "scheduleTime",
    };
  }

  let retryIntervalMS = initialInterval;
  let totalRuntimeMS = 0;

  for (let i = 0; i < state.retries.length; ++i) {
    const currentRetryRuntime = state.retries[i].runtimeMS;
    totalRuntimeMS += currentRetryRuntime;

    if (currentRetryRuntime >= startToCloseTimeout) {
      return {
        success: false,
        runtimeMS: totalRuntimeMS,
        attempts: i + 1,
        reason: "startToCloseTimeout",
      };
    }

    if (!state.retries[i].success) {
      if (maximumAttempts > 0 && i + 1 >= maximumAttempts) {
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "maximumAttempts",
        };
      }

      if (i + 1 >= state.retries.length) {
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "All retries failed",
        };
      }

      retryIntervalMS = Math.min(retryIntervalMS * backoffCoefficient, maximumInterval);

      totalRuntimeMS += retryIntervalMS;

      if (totalRuntimeMS >= scheduleToCloseTimeout) {
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "scheduleToCloseTimeout",
        };
      }
    }
  }

  if (state.retries.length === 0) {
    return {
      success: false,
      runtimeMS: 0,
      attempts: 0,
      reason: "No retries",
    };
  }

  return {
    success: true,
    attempts: state.retries.length,
    runtimeMS: totalRuntimeMS,
  };
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
  // Resolve the SDK default for maximumInterval against whatever
  // initialInterval the URL ended up with.
  if (!params.has("maximumInterval")) {
    out.maximumInterval = defaultMaximumInterval(out.initialInterval);
  }
  return out;
}
