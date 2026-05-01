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
    .map((r) => {
      const base = `${r.success ? "succeed" : "fail"}:${r.runtimeMS}`;
      const count = r.count ?? 1;
      return count > 1 ? `${base}*${count}` : base;
    })
    .join(",");
}

function decodeRetries(raw) {
  const parts = raw.split(",");
  const retries = [];
  for (const part of parts) {
    const [outcome, rest] = part.split(":");
    if ((outcome !== "succeed" && outcome !== "fail") || rest == null) {
      return null;
    }
    const [runtimeRaw, countRaw] = rest.split("*");
    const runtimeMS = Number(runtimeRaw);
    if (!Number.isFinite(runtimeMS)) {
      return null;
    }
    const count = countRaw == null ? 1 : Number(countRaw);
    if (!Number.isInteger(count) || count < 1) {
      return null;
    }
    const retry = { success: outcome === "succeed", runtimeMS };
    if (count > 1) retry.count = count;
    retries.push(retry);
  }
  return retries.length > 0 ? retries : null;
}

function retriesEqualDefault(retries) {
  const def = DEFAULT_STATE.retries;
  if (retries.length !== def.length) return false;
  for (let i = 0; i < retries.length; ++i) {
    if (
      retries[i].success !== def[i].success ||
      retries[i].runtimeMS !== def[i].runtimeMS ||
      (retries[i].count ?? 1) !== (def[i].count ?? 1)
    ) {
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

  // Expand each retry entry by its count so a single configured failure
  // can stand in for many sequential attempts with the same runtime.
  const flatRetries = state.retries.flatMap((r) =>
    Array.from({ length: r.count ?? 1 }, () => ({ success: r.success, runtimeMS: r.runtimeMS }))
  );

  let retryIntervalMS = initialInterval;
  let totalRuntimeMS = 0;

  for (let i = 0; i < flatRetries.length; ++i) {
    const currentRetryRuntime = flatRetries[i].runtimeMS;
    totalRuntimeMS += currentRetryRuntime;

    if (startToCloseTimeout > 0 && currentRetryRuntime >= startToCloseTimeout) {
      return {
        success: false,
        runtimeMS: totalRuntimeMS,
        attempts: i + 1,
        reason: "startToCloseTimeout",
      };
    }

    if (!flatRetries[i].success) {
      if (maximumAttempts > 0 && i + 1 >= maximumAttempts) {
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "maximumAttempts",
        };
      }

      if (i + 1 >= flatRetries.length) {
        // No follow-up retry is configured. If nothing else would ever
        // terminate the chain, treat this as an open-ended infinite retry
        // loop rather than a definite failure.
        const startToCloseSafe =
          startToCloseTimeout === 0 || currentRetryRuntime < startToCloseTimeout;
        if (maximumAttempts === 0 && scheduleToCloseTimeout === 0 && startToCloseSafe) {
          return {
            success: null,
            runtimeMS: totalRuntimeMS,
            attempts: Infinity,
            reason: "neverTerminates",
          };
        }
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "All retries failed",
        };
      }

      retryIntervalMS = Math.min(retryIntervalMS * backoffCoefficient, maximumInterval);

      totalRuntimeMS += retryIntervalMS;

      if (scheduleToCloseTimeout > 0 && totalRuntimeMS >= scheduleToCloseTimeout) {
        return {
          success: false,
          runtimeMS: totalRuntimeMS,
          attempts: i + 1,
          reason: "scheduleToCloseTimeout",
        };
      }
    }
  }

  if (flatRetries.length === 0) {
    return {
      success: false,
      runtimeMS: 0,
      attempts: 0,
      reason: "No retries",
    };
  }

  return {
    success: true,
    attempts: flatRetries.length,
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
