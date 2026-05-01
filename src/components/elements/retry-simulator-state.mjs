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

/**
 * Render a millisecond value with the largest natural unit (ms, s, m, h)
 * and at most two fractional digits. e.g. 5100 → "5.1 s", 90000 → "1.5 m".
 */
export function formatDurationHuman(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  const round = (n) => Math.round(n * 100) / 100;
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  if (Math.abs(ms) < 60_000) return `${round(ms / 1000)}s`;
  if (Math.abs(ms) < 3_600_000) return `${round(ms / 60_000)}m`;
  return `${round(ms / 3_600_000)}h`;
}

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
      let segment = `${r.success ? "succeed" : "fail"}:after:${r.runtime.toString()}`;
      if (r.period instanceof Duration) {
        segment += `:period:${r.period.toString()}`;
      } else if (r.count != null && r.count > 1) {
        segment += `:attempts:${r.count}`;
      }
      return segment;
    })
    .join(",");
}

// Legacy positional format kept for backward compatibility with shared URLs:
// <outcome>:<value><unit?>(*count)?. Bare numbers are treated as ms.
const LEGACY_RETRY_PART_REGEX = /^(succeed|fail):(\d+(?:\.\d+)?)(ms|s|m|h)?(?:\*(\d+))?$/;

function decodeRetryPart(part) {
  // New format: <outcome>:after:<duration>(:attempts:<n>|:period:<duration>)?
  const tokens = part.split(":");
  if (tokens.length >= 3 && tokens[1] === "after") {
    const outcome = tokens[0];
    if (outcome !== "succeed" && outcome !== "fail") return null;
    const runtime = Duration.parse(tokens[2]);
    if (!runtime) return null;

    const retry = { success: outcome === "succeed", runtime };
    let i = 3;
    while (i < tokens.length) {
      const key = tokens[i];
      const value = tokens[i + 1];
      if (value == null) return null;
      if (key === "attempts") {
        if ("count" in retry || "period" in retry) return null;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return null;
        if (n > 1) retry.count = n;
      } else if (key === "period") {
        if ("count" in retry || "period" in retry) return null;
        const d = Duration.parse(value);
        if (!d || d.toMilliseconds() <= 0) return null;
        retry.period = d;
      } else {
        return null;
      }
      i += 2;
    }
    return retry;
  }

  // Legacy positional format.
  const legacy = LEGACY_RETRY_PART_REGEX.exec(part);
  if (!legacy) return null;
  const [, outcome, valueRaw, unitRaw, countRaw] = legacy;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return null;
  const unit = unitRaw ?? "ms";
  const count = countRaw == null ? 1 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1) return null;
  const retry = { success: outcome === "succeed", runtime: new Duration(value, unit) };
  if (count > 1) retry.count = count;
  return retry;
}

function decodeRetries(raw) {
  const parts = raw.split(",");
  const retries = [];
  for (const part of parts) {
    const retry = decodeRetryPart(part);
    if (!retry) return null;
    retries.push(retry);
  }
  return retries.length > 0 ? retries : null;
}

function retriesEqualDefault(retries) {
  const def = DEFAULT_STATE.retries;
  if (retries.length !== def.length) return false;
  for (let i = 0; i < retries.length; ++i) {
    const a = retries[i];
    const b = def[i];
    if (
      a.success !== b.success ||
      !a.runtime.equals(b.runtime) ||
      (a.count ?? 1) !== (b.count ?? 1)
    ) {
      return false;
    }
    const aPeriod = a.period instanceof Duration;
    const bPeriod = b.period instanceof Duration;
    if (aPeriod !== bPeriod) return false;
    if (aPeriod && bPeriod && !a.period.equals(b.period)) return false;
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

  if (state.retries.length === 0) {
    return { success: false, runtimeMS: 0, attempts: 0, reason: "No retries" };
  }

  // Pre-compute per-entry numeric snapshots so the hot loop does only arithmetic.
  // Default to 1 attempt only when neither count nor period is configured;
  // a missing limit becomes Infinity so the per-iteration check stays uniform.
  const entries = state.retries.map((r) => {
    const periodMS = r.period instanceof Duration ? r.period.toMilliseconds() : null;
    return {
      runtimeMS: r.runtime.toMilliseconds(),
      success: r.success,
      countLimit: r.count ?? (periodMS != null ? Infinity : 1),
      periodLimitMS: periodMS ?? Infinity,
    };
  });

  // If the configured chain ends in a failure (or in a success that would be
  // killed by startToCloseTimeout — Temporal treats that as a per-attempt
  // timeout, not a successful run), the user is implicitly saying "and it
  // would keep going this way." Project additional attempts with the last
  // configured runtime until something terminates the chain.
  const lastConfigured = entries[entries.length - 1];
  const lastWouldTimeOut =
    startToCloseTimeout > 0 && lastConfigured.runtimeMS >= startToCloseTimeout;
  const lastWouldFail = !lastConfigured.success || lastWouldTimeOut;
  const projectedRuntimeMS = lastWouldFail ? lastConfigured.runtimeMS : null;

  // Detect open-ended infinite cases up front to avoid spinning in the loop:
  //   1. No maximumAttempts AND no scheduleToCloseTimeout — classic infinite retry.
  //   2. The projection's per-iteration wall-clock cost is zero (zero per-attempt
  //      elapsed time AND zero retry interval growth potential), so totalRuntimeMS
  //      can never reach scheduleToCloseTimeout no matter how big the cap is.
  if (projectedRuntimeMS != null) {
    const projectedAttemptElapsed =
      startToCloseTimeout > 0
        ? Math.min(projectedRuntimeMS, startToCloseTimeout)
        : projectedRuntimeMS;
    const projectedIntervalCap =
      maximumInterval > 0 ? maximumInterval : initialInterval;
    const noProgress = projectedAttemptElapsed === 0 && projectedIntervalCap === 0;
    if (
      maximumAttempts === 0 &&
      (scheduleToCloseTimeout === 0 || noProgress)
    ) {
      return { success: null, runtimeMS: 0, attempts: Infinity, reason: "neverTerminates" };
    }
  }

  // Hard iteration cap so a degenerate config (e.g. period=24h with zero
  // per-iteration progress) can't lock up the page. Reaching this cap means
  // the simulation hasn't converged in a reasonable bound; reporting
  // neverTerminates is more honest than continuing.
  const ITERATION_GUARD = 1_000_000;

  let retryIntervalMS = initialInterval;
  let totalRuntimeMS = 0;

  // Walk configured retry entries. Each entry is bounded by either an attempt
  // count (default 1 when neither count nor period is set) or a wall-clock
  // period; the loop advances to the next entry as soon as either limit is
  // reached, then projects beyond the last entry as needed.
  let entryIndex = 0;
  let entryAttemptsUsed = 0;
  let entryElapsedMS = 0;

  for (let i = 0; i < ITERATION_GUARD; ++i) {
    let currentRetryRuntime;
    let isSuccess;
    if (entryIndex < entries.length) {
      const entry = entries[entryIndex];
      currentRetryRuntime = entry.runtimeMS;
      isSuccess = entry.success;
    } else {
      if (projectedRuntimeMS == null) {
        return { success: null, runtimeMS: totalRuntimeMS, attempts: Infinity, reason: "neverTerminates" };
      }
      currentRetryRuntime = projectedRuntimeMS;
      isSuccess = false;
    }

    // startToCloseTimeout is a per-attempt cap, not a terminal failure. If the
    // attempt would run longer than the timeout, the Server kills it after
    // `startToCloseTimeout` ms and the attempt counts as a failure regardless
    // of the user's intended outcome. The retry policy then decides whether
    // to schedule another Activity Task.
    let attemptElapsed = currentRetryRuntime;
    if (startToCloseTimeout > 0 && currentRetryRuntime >= startToCloseTimeout) {
      attemptElapsed = startToCloseTimeout;
      isSuccess = false;
    }
    totalRuntimeMS += attemptElapsed;
    entryElapsedMS += attemptElapsed;
    entryAttemptsUsed += 1;

    if (isSuccess) {
      return { success: true, runtimeMS: totalRuntimeMS, attempts: i + 1 };
    }

    if (maximumAttempts > 0 && i + 1 >= maximumAttempts) {
      return {
        success: false,
        runtimeMS: totalRuntimeMS,
        attempts: i + 1,
        reason: "maximumAttempts",
      };
    }

    retryIntervalMS = Math.min(retryIntervalMS * backoffCoefficient, maximumInterval);
    totalRuntimeMS += retryIntervalMS;
    entryElapsedMS += retryIntervalMS;

    if (scheduleToCloseTimeout > 0 && totalRuntimeMS >= scheduleToCloseTimeout) {
      return {
        success: false,
        runtimeMS: totalRuntimeMS,
        attempts: i + 1,
        reason: "scheduleToCloseTimeout",
      };
    }

    // Advance to the next configured entry once the active one is exhausted.
    if (entryIndex < entries.length) {
      const entry = entries[entryIndex];
      if (entryAttemptsUsed >= entry.countLimit || entryElapsedMS >= entry.periodLimitMS) {
        entryIndex += 1;
        entryAttemptsUsed = 0;
        entryElapsedMS = 0;
      }
    }
  }
  // Hit the iteration guard — the simulation isn't converging.
  return { success: null, runtimeMS: totalRuntimeMS, attempts: Infinity, reason: "neverTerminates" };
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
