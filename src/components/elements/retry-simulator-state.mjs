// SDK Retry Policy default: Maximum Interval = 100 × Initial Interval.
// (https://docs.temporal.io/encyclopedia/retry-policies#default-values-for-retry-policy)
const MAX_INTERVAL_MULTIPLIER = 100;

export const DURATION_UNITS = ["ms", "s", "m", "h"];

const UNIT_TO_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

export const UNIT_TO_GO = {
  ms: "time.Millisecond",
  s: "time.Second",
  m: "time.Minute",
  h: "time.Hour",
};

export const UNIT_LABELS = {
  ms: "millisecond(s)",
  s: "second(s)",
  m: "minute(s)",
  h: "hour(s)",
};

const DEFAULT_DURATION_UNIT = "s";

/**
 * Duration carries both a numeric value and the display unit it was entered in.
 * State holds these instances directly; calculation pulls millisecond values
 * via toMilliseconds() so the underlying arithmetic stays a single unit.
 */
export class Duration {
  constructor(value, unit = DEFAULT_DURATION_UNIT) {
    if (UNIT_TO_MS[unit] == null) {
      throw new Error(`Unknown duration unit: ${unit}`);
    }
    this.value = value;
    this.unit = unit;
  }

  static fromMilliseconds(ms, unit = DEFAULT_DURATION_UNIT) {
    return new Duration(ms / UNIT_TO_MS[unit], unit);
  }

  static parse(raw) {
    const match = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || UNIT_TO_MS[unit] == null) return null;
    return new Duration(value, unit);
  }

  toMilliseconds() {
    return this.value * UNIT_TO_MS[this.unit];
  }

  /** Returns a new Duration with the same unit but a new display value. */
  withValue(value) {
    return new Duration(value, this.unit);
  }

  /**
   * Returns a new Duration with the same numeric value but a different unit.
   * The total milliseconds change — switching "1 s" to hours yields "1 h".
   */
  withUnit(unit) {
    return new Duration(this.value, unit);
  }

  toString() {
    return `${this.value}${this.unit}`;
  }

  equals(other) {
    return other instanceof Duration && this.toMilliseconds() === other.toMilliseconds();
  }
}

const DEFAULT_INITIAL_INTERVAL = new Duration(1, "s");

// Fields whose state values are Duration instances. Tagged here so encode/decode
// and equality checks know to format/parse them with units instead of as bare numbers.
export const DURATION_FIELDS = [
  "scheduleToStartTimeout",
  "scheduleToCloseTimeout",
  "startToCloseTimeout",
  "initialInterval",
  "maximumInterval",
  "scheduleTime",
];

const DEFAULT_STATE = {
  retries: [{ success: true, runtime: new Duration(1, "s") }],
  language: "typescript",
  scheduleToStartTimeout: new Duration(0, "s"),
  scheduleToCloseTimeout: new Duration(24, "h"),
  startToCloseTimeout: new Duration(0, "s"),
  backoffCoefficient: 2,
  initialInterval: DEFAULT_INITIAL_INTERVAL,
  scheduleTime: new Duration(0, "s"),
  maximumAttempts: 0,
  maximumInterval: Duration.fromMilliseconds(
    MAX_INTERVAL_MULTIPLIER * DEFAULT_INITIAL_INTERVAL.toMilliseconds(),
    "s"
  ),
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
      const base = `${r.success ? "succeed" : "fail"}:${r.runtime.toString()}`;
      const count = r.count ?? 1;
      return count > 1 ? `${base}*${count}` : base;
    })
    .join(",");
}

// Matches "<outcome>:<value><unit?>(*count)?". Bare numbers (no unit) are
// treated as milliseconds for backward compatibility with older URLs.
const RETRY_PART_REGEX = /^(succeed|fail):(\d+(?:\.\d+)?)(ms|s|m|h)?(?:\*(\d+))?$/;

function decodeRetries(raw) {
  const parts = raw.split(",");
  const retries = [];
  for (const part of parts) {
    const match = RETRY_PART_REGEX.exec(part);
    if (!match) return null;
    const [, outcome, valueRaw, unitRaw, countRaw] = match;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) {
      return null;
    }
    const unit = unitRaw ?? "ms";
    const count = countRaw == null ? 1 : Number(countRaw);
    if (!Number.isInteger(count) || count < 1) {
      return null;
    }
    const retry = {
      success: outcome === "succeed",
      runtime: new Duration(value, unit),
    };
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
      !retries[i].runtime.equals(def[i].runtime) ||
      (retries[i].count ?? 1) !== (def[i].count ?? 1)
    ) {
      return false;
    }
  }
  return true;
}

function defaultMaximumInterval(initialInterval) {
  return Duration.fromMilliseconds(
    MAX_INTERVAL_MULTIPLIER * initialInterval.toMilliseconds(),
    initialInterval.unit
  );
}

function fieldDefault(key, state) {
  if (key === "maximumInterval") {
    return defaultMaximumInterval(state.initialInterval);
  }
  return DEFAULT_STATE[key];
}

function fieldEqualsDefault(key, state) {
  const def = fieldDefault(key, state);
  const value = state[key];
  if (def instanceof Duration) {
    return value instanceof Duration && value.equals(def);
  }
  return value === def;
}

export function encodeStateToParams(state) {
  const params = new URLSearchParams();
  for (const key of NUMERIC_FIELDS) {
    if (fieldEqualsDefault(key, state)) continue;
    if (DURATION_FIELDS.includes(key)) {
      params.set(key, state[key].toString());
    } else {
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
  const startToCloseTimeout = state.startToCloseTimeout.toMilliseconds();
  const scheduleToCloseTimeout = state.scheduleToCloseTimeout.toMilliseconds();
  const scheduleToStartTimeout = state.scheduleToStartTimeout.toMilliseconds();
  const scheduleTime = state.scheduleTime.toMilliseconds();
  const initialInterval = state.initialInterval.toMilliseconds();
  const maximumInterval = state.maximumInterval.toMilliseconds();
  const { maximumAttempts, backoffCoefficient } = state;

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
    Array.from({ length: r.count ?? 1 }, () => ({
      success: r.success,
      runtimeMS: r.runtime.toMilliseconds(),
    }))
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
    if (DURATION_FIELDS.includes(key)) {
      const parsed = Duration.parse(params.get(key));
      if (parsed) {
        out[key] = parsed;
      }
    } else {
      const value = Number(params.get(key));
      if (Number.isFinite(value)) {
        out[key] = value;
      }
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
