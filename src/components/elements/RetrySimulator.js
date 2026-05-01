import Chart from "chart.js/auto";
import CodeBlock from "@theme/CodeBlock";
import React, { useState, useCallback, useEffect, useRef } from "react";
import styles from "./retry-simulator.module.css";
import { useColorMode } from "@docusaurus/theme-common";
import {
  Duration,
  DURATION_UNITS,
  UNIT_LABELS,
  UNIT_TO_GO,
  calculateResult,
  decodeStateFromParams,
  encodeStateToParams,
  formatDurationHuman,
} from "./retry-simulator-state.mjs";

// Per-attempt bar colors on the retry-interval chart.
const OUTCOME_COLORS = {
  succeeded: "#5cb85c", // green
  failed: "#d9534f", // red
  timedOut: "#f0ad4e", // orange
  notUsed: "#bbbbbb", // gray
};

// Maps simulator outcomes to the Workflow History event type a real Temporal
// Server would record for that attempt's terminal state.
const OUTCOME_EVENT_TYPE = {
  succeeded: "ActivityTaskCompleted",
  failed: "ActivityTaskFailed",
  timedOut: "ActivityTaskTimedOut",
};

// Hard upper bound on bars rendered in either chart. Beyond this, individual
// attempts get unreadably small; the simulation still tracks the actual count.
const SLOT_CAP = 100;

// Chart.js plugin: draws a vertical red line at scheduleToCloseTimeout on the
// timeline chart. The chart instance carries the current timeout in
// `chart.$scheduleToCloseTimeoutMS` (set by updateTimeline) — this lives on the
// chart rather than module state so it survives across renders without forcing
// the plugin into a React closure.
const scheduleToCloseMarkerPlugin = {
  id: "scheduleToCloseMarker",
  afterDraw(chart) {
    const timeoutMS = chart.$scheduleToCloseTimeoutMS;
    if (!(timeoutMS > 0)) return;
    const xScale = chart.scales.x;
    if (!xScale) return;
    if (timeoutMS < xScale.min || timeoutMS > xScale.max) return;
    const x = xScale.getPixelForValue(timeoutMS);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "#d9534f";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d9534f";
    ctx.font = "11px sans-serif";
    ctx.textAlign = x > (xScale.left + xScale.right) / 2 ? "right" : "left";
    const labelX = x + (ctx.textAlign === "right" ? -4 : 4);
    ctx.fillText("scheduleToCloseTimeout", labelX, top + 12);
    ctx.restore();
  },
};

// Map result.reason to a user-facing caption. Successful runs return null —
// the green final bar makes the outcome obvious without an extra caption.
const LIMIT_REASON_LABELS = {
  scheduleToCloseTimeout: "Chain ended: scheduleToCloseTimeout reached",
  maximumAttempts: "Chain ended: maximumAttempts reached",
  scheduleTime: "Activity Task expired before being picked up",
  neverTerminates: "Activity never terminates — projected indefinitely",
  "No retries": "No retry entries configured",
};

const languageSamples = new Map([]);
languageSamples.set(
  "typescript",
  `
import axios from 'axios';

async function testActivity(url: string): Promise<void> {
  await axios.get(url);
}

export default testActivity;
`.trim()
);
languageSamples.set(
  "go",
  `
package sample

import (
	"context"
	"io/ioutil"
	"net/http"
)

func TestActivity(ctx context.Context, url string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	body, err := ioutil.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return err
	}

	return nil
}
`.trim()
);

export default function RetrySimulator() {
  const [state, setState] = useState(() => decodeStateFromParams(""));
  const chartCanvas = useRef(null);
  const timelineCanvas = useRef(null);
  const hasHydratedFromUrl = useRef(false);
  const { colorMode } = useColorMode();
  const isDarkTheme = colorMode === 'dark';

  const addRetry = useCallback(function addRetry(success) {
    const retries = [...state.retries];
    if (retries.length > 0) {
      retries[retries.length - 1] = {
        ...retries[retries.length - 1],
        success: false,
      };
    }
    retries.push({ success, runtime: new Duration(1, "s") });

    setState({ ...state, retries });
  });

  const updateRetry = useCallback(function updateRetry(index, update) {
    const retries = [...state.retries];
    if (update.count != null) {
      update.count = Math.max(1, Math.floor(+update.count));
      if (isNaN(update.count)) {
        delete update.count;
      }
    }
    retries[index] = { ...retries[index], ...update };
    // The UI toggles between count and period modes; passing null for one
    // clears it from state so encode/decode stays minimal and the two fields
    // never coexist accidentally. (Don't drop count=1 here — the user can
    // explicitly land on 1 via the spinner; keeping it in state lets the
    // input render the typed value instead of falling back to a stashed
    // mode-switch default.)
    if (update.count === null) {
      delete retries[index].count;
    }
    if (update.period === null) {
      delete retries[index].period;
    }
    setState({ ...state, retries });
  });

  const deleteRetry = useCallback(function deleteRetry(index) {
    const retries = [...state.retries];
    retries.splice(index, 1);
    setState({ ...state, retries });
  });

  const applyRetryScenario = useCallback(function applyRetryScenario(values) {
    if (!values) {
      return;
    }
    values = JSON.parse(values);

    if (values.scenario === "outage") {
      const period = new Duration(values.periodValue, values.periodUnit);
      setState({
        ...state,
        retries: [
          { success: false, runtime: new Duration(100, "ms"), period },
          { success: true, runtime: new Duration(100, "ms") },
        ],
      });
      return;
    }

    if (values.scenario === "latency") {
      // Latency only "matters" when each attempt is killed by the per-attempt
      // startToCloseTimeout — otherwise the first slow success ends the
      // simulation immediately. We leave startToCloseTimeout alone here so
      // the scenario doesn't surprise the user by overwriting their timeout
      // config; configure one alongside this scenario to see the latency
      // window drive retries.
      const period = new Duration(values.periodValue, values.periodUnit);
      setState({
        ...state,
        retries: [
          { success: true, runtime: new Duration(5, "s"), period },
          { success: true, runtime: new Duration(100, "ms") },
        ],
      });
      return;
    }

    const requestRuntimeMS = values.requestRuntimeMS;
    const successRate = values.successRate;
    const retries = [];
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; ++i) {
      const success = Math.random() < successRate || i === maxRetries - 1;
      const runtimeMS = requestRuntimeMS + Math.round((Math.random() - 0.5) * (requestRuntimeMS / 2)); // +/- 50%
      retries.push({ success, runtime: new Duration(runtimeMS, "ms") });
      if (success) {
        break;
      }
    }

    setState({ ...state, retries });
  });

  const updateRetryPolicyParam = useCallback(function updateRetryPolicyParam(prop, ev) {
    const value = getEventValue(ev);
    if (isNaN(value)) {
      return;
    }
    const next = +value;
    const current = state[prop];
    // Duration fields keep their selected unit when the numeric value changes.
    const update = current instanceof Duration ? current.withValue(next) : next;
    setState({ ...state, [prop]: update });
    updateChart();
  });

  const updateRetryPolicyParamUnit = useCallback(function updateRetryPolicyParamUnit(prop, unit) {
    const current = state[prop];
    if (!(current instanceof Duration)) return;
    setState({ ...state, [prop]: current.withUnit(unit) });
  });

  const updateChart = useCallback(function updateChart() {
    if (chartCanvas.current == null || chartCanvas.current.chart == null) {
      return;
    }
    const chart = chartCanvas.current.chart;

    const { backoffCoefficient } = state;
    const initialInterval = state.initialInterval.toMilliseconds();
    const maximumInterval = state.maximumInterval.toMilliseconds();
    const { maximumAttempts } = state;
    const labels = [];
    const values = [];
    // Run the simulation alongside the chart so each bar is colored by what
    // actually happened on that attempt (succeeded / failed / timed out) or
    // grayed out for slots the activity never reached. Cap tracked outcomes
    // at SLOT_CAP since the chart can't usefully render more bars than that.
    const result = calculateResult(state, { trackOutcomes: SLOT_CAP });
    const baseSlots = maximumAttempts === 0 ? 10 : Math.min(maximumAttempts, 30);
    // When the activity terminates, grow the chart to cover every attempt that
    // actually ran so the user can see the full retry sequence. For the
    // never-terminates branch (result.success === null) we keep the baseline
    // slot count — there's no meaningful "all attempts" to show.
    const slots =
      result.success !== null
        ? Math.min(SLOT_CAP, Math.max(baseSlots, result.attempts))
        : baseSlots;
    const attemptTimeline = result.attemptTimeline || [];
    let interval = initialInterval;
    const colors = [];
    for (let i = 0; i < slots; ++i) {
      interval = Math.min(interval, maximumInterval);
      labels.push(i + 1);
      values.push(interval);
      colors.push(OUTCOME_COLORS[attemptTimeline[i]?.outcome] || OUTCOME_COLORS.notUsed);
      interval = interval * backoffCoefficient;
    }

    if (labels.length > chart.data.labels.length) {
      chart.data.labels.push(...labels.slice(chart.data.labels.length));
    } else if (labels.length < chart.data.labels.length) {
      chart.data.labels.splice(labels.length, chart.data.length - labels.length);
    }
    chart.data.labels = labels;
    chart.data.datasets = [
      {
        label: "Retry interval after each attempt (ms)",
        backgroundColor: colors,
        borderColor: colors,
        data: values,
      },
    ];
    chart.update();
  });

  const updateTimeline = useCallback(function updateTimeline() {
    if (timelineCanvas.current == null || timelineCanvas.current.chart == null) {
      return;
    }
    const chart = timelineCanvas.current.chart;
    const result = calculateResult(state, { trackOutcomes: SLOT_CAP });
    const timeline = result.attemptTimeline || [];
    const labels = timeline.map((_, i) => i + 1);
    // Floating bars: each data point is [start, end] in ms. Chart.js renders
    // them as horizontal spans on the wall-clock X-axis when indexAxis is "y".
    const data = timeline.map((a) => [a.startMS, a.startMS + a.elapsedMS]);
    const colors = timeline.map((a) => OUTCOME_COLORS[a.outcome] || OUTCOME_COLORS.notUsed);

    const scheduleToCloseMS = state.scheduleToCloseTimeout.toMilliseconds();
    chart.$scheduleToCloseTimeoutMS = scheduleToCloseMS;
    chart.$timeline = timeline;

    // Anchor the X-axis to at least 5× the first attempt's duration so a
    // single quick attempt doesn't render against a tiny zoomed-in axis. The
    // existing data-driven max takes over once attempts run past this floor.
    const firstAttemptElapsed = timeline[0]?.elapsedMS ?? 0;
    chart.options.scales.x.suggestedMin = 0;
    chart.options.scales.x.suggestedMax = firstAttemptElapsed * 5;

    chart.data.labels = labels;
    chart.data.datasets = [
      {
        label: "Attempt time on the wall clock",
        backgroundColor: colors,
        borderColor: colors,
        data,
        borderWidth: 1,
        // Make zero-elapsed-time attempts visible by giving them a minimum
        // pixel width via barPercentage; otherwise instantaneous attempts
        // wouldn't render at all.
        minBarLength: 4,
      },
    ];
    chart.update();
  });

  const updateLanguage = useCallback(function updateLanguage(language) {
    setState({ ...state, language });
  });

  const { success, runtimeMS, reason, attempts } = calculateResult(state);
  const code = retryPolicyCode(state);

  useEffect(
    function initializeChart() {
      const chart = new Chart(chartCanvas.current, {
        type: "bar",
        options: {
          responsive: true,
          scales: {
            y: {
              grid: {
                color: "#ddd",
              },
            },
            x: {
              grid: {
                color: "#ddd",
              },
            },
          },
        },
      });
      chartCanvas.current.chart = chart;

      updateChart();
    },
    [chartCanvas]
  );

  useEffect(
    function initializeTimelineChart() {
      const chart = new Chart(timelineCanvas.current, {
        type: "bar",
        plugins: [scheduleToCloseMarkerPlugin],
        options: {
          responsive: true,
          indexAxis: "y",
          scales: {
            x: {
              type: "linear",
              title: { display: true, text: "Wall-clock time" },
              grid: { color: "#ddd" },
              ticks: {
                callback: (value) => formatDurationHuman(value),
              },
            },
            y: {
              title: { display: true, text: "Attempt" },
              grid: { color: "#ddd" },
              ticks: { autoSkip: true, maxTicksLimit: 12 },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `Attempt ${items[0].label}`,
                label: (item) => {
                  const [start, end] = item.raw;
                  const span = `${formatDurationHuman(start)} → ${formatDurationHuman(end)} (${formatDurationHuman(end - start)})`;
                  const attempt = item.chart.$timeline?.[item.dataIndex];
                  if (!attempt) return span;
                  return [span, `Status: ${OUTCOME_EVENT_TYPE[attempt.outcome]}`];
                },
              },
            },
          },
        },
      });
      timelineCanvas.current.chart = chart;

      updateTimeline();
    },
    [timelineCanvas]
  );

  useEffect(
    function updateChartDarkTheme() {
      const charts = [chartCanvas.current?.chart, timelineCanvas.current?.chart].filter(Boolean);
      const gridColor = isDarkTheme ? "#222" : "#ddd";
      for (const chart of charts) {
        if (chart.options.scales?.x?.grid) chart.options.scales.x.grid.color = gridColor;
        if (chart.options.scales?.y?.grid) chart.options.scales.y.grid.color = gridColor;
        chart.update();
      }
    },
    [isDarkTheme]
  );

  useEffect(function loadStateFromUrl() {
    setState(decodeStateFromParams(window.location.search));
  }, []);

  useEffect(function persistStateToUrl() {
    // Skip the first run so we don't briefly clobber the URL with
    // empty params before loadStateFromUrl's setState has been applied.
    if (!hasHydratedFromUrl.current) {
      hasHydratedFromUrl.current = true;
      return;
    }
    const params = encodeStateToParams(state);
    const query = params.toString();
    const newUrl =
      window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, [state]);

  useEffect(() => {
    updateChart();
    updateTimeline();
  }, [state]);

  return (
    <div className={styles.retrySimulator}>
      <div className={styles.retryRow}>
        <div className={styles.retryCol}>
          <div className="retries">
            <h3>Sample Activity</h3>

            <div>
              <select
                className={styles.dropdown}
                value={state.language}
                onChange={(ev) => updateLanguage(ev.target.value)}
              >
                <option value="typescript">TypeScript</option>
                <option value="go">Go</option>
              </select>
            </div>

            <CodeBlock language={state.language} className={styles.codeBlock}>
              {languageSamples.get(state.language)}
            </CodeBlock>

            <h3>Sample Retry Policy</h3>
            <CodeBlock language={state.language} className={styles.codeBlock}>
              {code}
            </CodeBlock>

            <h3>Activity Retries (in ms)</h3>

            <select className={styles.dropdown} onChange={(ev) => applyRetryScenario(ev.target.value)}>
              <option value="">Generate a Scenario</option>
              <option value='{"requestRuntimeMS": 10, "successRate": 0.9}'>
                Fast request (10ms), 90% success rate
              </option>
              <option value='{"requestRuntimeMS": 10, "successRate": 0.5}'>
                Fast request (10ms), 50% success rate
              </option>
              <option value='{"requestRuntimeMS": 100, "successRate": 0.9}'>
                Slow request (100ms), 90% success rate
              </option>
              <option value='{"requestRuntimeMS": 100, "successRate": 0.5}'>
                Slow request (100ms), 50% success rate
              </option>
              <option value='{"scenario":"outage","periodValue":1,"periodUnit":"h"}'>
                Sustained downstream outage (1 hour)
              </option>
              <option value='{"scenario":"latency","periodValue":30,"periodUnit":"m"}'>
                Sustained downstream latency (30 min)
              </option>
            </select>
          </div>
          <div className={styles.scheduleTime}>
            <div className={styles.inputContainer}>
              <label className={styles.numberInputLabel}>Task Time in Queue</label>
              {/* With float: right, the element rendered first ends up rightmost. */}
              <select
                className={styles.unitSelect}
                value={state.scheduleTime.unit}
                onChange={(ev) => updateRetryPolicyParamUnit("scheduleTime", ev.target.value)}
              >
                {DURATION_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
              <input
                className={styles.numberInput}
                value={state.scheduleTime.value}
                onChange={(ev) => updateRetryPolicyParam("scheduleTime", ev)}
                type="number"
              />
            </div>
          </div>
          <div className="retries-list">
            {state.retries.map((retry, index) => {
              return (
                <RetryConfig
                  retry={retry}
                  numRetries={state.retries.length}
                  index={index}
                  updateRetry={updateRetry}
                  deleteRetry={deleteRetry}
                  key={index}
                />
              );
            })}
          </div>
          <button className={styles.addButton} onClick={() => addRetry(true)}>
            + Add
          </button>
        </div>
        <div className={styles.retryCol}>
          <h3>Activity Timeouts</h3>
          <RetryPolicyParamInputs
            param="startToCloseTimeout"
            value={state.startToCloseTimeout}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="scheduleToCloseTimeout"
            value={state.scheduleToCloseTimeout}
            max={24 * 60 * 60 * 1000}
            step={60 * 1000}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="scheduleToStartTimeout"
            value={state.scheduleToStartTimeout}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <h3>Retry Policy</h3>
          <RetryPolicyParamInputs
            param="backoffCoefficient"
            value={state.backoffCoefficient}
            min={1}
            max={10}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="initialInterval"
            value={state.initialInterval}
            min={1}
            max={10000}
            step={50}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="maximumAttempts"
            value={state.maximumAttempts}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="maximumInterval"
            value={state.maximumInterval}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
        </div>
      </div>
      <div className={styles.retryRow}>
        <div className={styles.retryCol}>
          <div className={styles.result + " " + (success === true ? styles.success : styles.fail)}>
            <h3 className={styles.resultText}>
              {success === null
                ? "Never terminates — unlimited attempts"
                : `${success ? "Success" : "Failed"} after ${formatDurationHuman(runtimeMS)} (${attempts} ${
                    attempts === 1 ? "attempt" : "attempts"
                  })${success ? "" : ": " + reason}`}
            </h3>
          </div>
        </div>
        <div className={styles.retryCol}>
          <canvas ref={chartCanvas}></canvas>
        </div>
      </div>
      <div className={styles.timelineSection}>
        <h3>Attempt Timeline</h3>
        <canvas ref={timelineCanvas}></canvas>
        {LIMIT_REASON_LABELS[reason] && (
          <div className={styles.limitReason}>{LIMIT_REASON_LABELS[reason]}</div>
        )}
      </div>
    </div>
  );
}

function RetryConfig({ retry, numRetries, index, updateRetry, deleteRetry }) {
  const runtime = retry.runtime;
  const periodMode = retry.period instanceof Duration;
  // Remember the inactive mode's last value/unit across toggles so switching
  // count → period → count doesn't reset what the user typed. We seed from
  // retry state and refresh when retry state changes externally (URL load,
  // scenario applied).
  const [stashedCount, setStashedCount] = useState(retry.count ?? 1);
  const [stashedPeriod, setStashedPeriod] = useState(
    retry.period instanceof Duration ? retry.period : new Duration(1, "m")
  );
  useEffect(() => {
    if (retry.count != null) setStashedCount(retry.count);
  }, [retry.count]);
  useEffect(() => {
    if (retry.period instanceof Duration) setStashedPeriod(retry.period);
  }, [retry.period]);
  const count = retry.count ?? stashedCount;
  const period = retry.period instanceof Duration ? retry.period : stashedPeriod;
  return (
    <div className={styles.retry} key={"retry-" + index}>
      <div className={styles.inputContainer}>
        <select
          className={styles.numberInputLabel}
          disabled={index + 1 < numRetries}
          value={retry.success ? "succeeds" : "fails"}
          onChange={(ev) => updateRetry(index, { success: ev.target.value === "success" })}
        >
          <option value="fails">Fails after</option>
          <option value="succeeds">Succeeds after</option>
        </select>
        {/* With float: right, the element rendered first ends up rightmost. */}
        <select
          className={styles.unitSelect}
          value={runtime.unit}
          onChange={(ev) =>
            updateRetry(index, { runtime: runtime.withUnit(ev.target.value) })
          }
        >
          {DURATION_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
        <input
          type="number"
          className={styles.numberInput}
          value={runtime.value}
          onChange={(ev) => {
            const next = +ev.target.value;
            if (isNaN(next)) return;
            updateRetry(index, { runtime: runtime.withValue(next) });
          }}
        />
        <span className={styles.removeRetry} onClick={() => deleteRetry(index)}>
          &times;
        </span>
      </div>
      {index + 1 < numRetries && (
        <>
          <div className={styles.retryCountRow}>
            <input
              type="radio"
              name={`retryRepeat-${index}`}
              checked={!periodMode}
              onChange={() => updateRetry(index, { period: null, count: count })}
            />
            <span className={styles.retryCountLabel}>×</span>
            <input
              type="number"
              min={1}
              step={1}
              className={styles.retryCountInput}
              value={count}
              disabled={periodMode}
              onChange={(ev) => updateRetry(index, { count: ev.target.value, period: null })}
            />
            <span className={styles.retryCountSuffix}>
              {count === 1
                ? "attempt"
                : `attempts, avg ${runtime.value} ${runtime.unit} each`}
            </span>
          </div>
          <div className={styles.retryCountRow}>
            <input
              type="radio"
              name={`retryRepeat-${index}`}
              checked={periodMode}
              onChange={() => updateRetry(index, { period, count: null })}
            />
            <span className={styles.retryCountLabel}>for</span>
            <input
              type="number"
              min={1}
              step={1}
              className={styles.retryCountInput}
              value={period.value}
              disabled={!periodMode}
              onChange={(ev) => {
                const next = +ev.target.value;
                if (isNaN(next)) return;
                updateRetry(index, { period: period.withValue(next), count: null });
              }}
            />
            <select
              className={styles.unitSelect}
              value={period.unit}
              disabled={!periodMode}
              onChange={(ev) =>
                updateRetry(index, { period: period.withUnit(ev.target.value), count: null })
              }
            >
              {DURATION_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}

const PARAM_METADATA = {
  startToCloseTimeout: {
    label: "Start-To-Close",
    description:
      "Maximum time allowed for a single Activity Task Execution. Either this or Schedule-To-Close must be set.",
    href: "https://docs.temporal.io/encyclopedia/detecting-activity-failures#start-to-close-timeout",
    defaultDisplay: "∞",
  },
  scheduleToStartTimeout: {
    label: "Schedule-To-Start",
    description:
      "Maximum time from when an Activity Task is scheduled to when a Worker picks it up.",
    href: "https://docs.temporal.io/encyclopedia/detecting-activity-failures#schedule-to-start-timeout",
    defaultDisplay: "∞",
  },
  scheduleToCloseTimeout: {
    label: "Schedule-To-Close",
    description:
      "Maximum time for the overall Activity Execution, from first scheduling to last completion.",
    href: "https://docs.temporal.io/encyclopedia/detecting-activity-failures#schedule-to-close-timeout",
    defaultDisplay: "∞",
  },
  backoffCoefficient: {
    label: "Backoff Coefficient",
    description: "Multiplier applied to each successive retry interval.",
    href: "https://docs.temporal.io/encyclopedia/retry-policies#backoff-coefficient",
    defaultDisplay: "2",
  },
  initialInterval: {
    label: "Initial Interval",
    description: "Amount of time that must elapse before the first retry occurs.",
    href: "https://docs.temporal.io/encyclopedia/retry-policies#initial-interval",
    defaultDisplay: "1000 ms",
  },
  maximumAttempts: {
    label: "Maximum Attempts",
    description:
      "Maximum number of execution attempts that can be made in the presence of failures (0 means unlimited).",
    href: "https://docs.temporal.io/encyclopedia/retry-policies#maximum-attempts",
    defaultDisplay: "∞",
  },
  maximumInterval: {
    label: "Maximum Interval",
    description: "Upper bound on the interval between retries.",
    href: "https://docs.temporal.io/encyclopedia/retry-policies#maximum-interval",
    defaultDisplay: "100 × Initial Interval",
  },
};

function RetryPolicyParamInputs({
  param,
  value,
  updateRetryPolicyParam,
  updateRetryPolicyParamUnit,
  min,
  max,
  step,
}) {
  const meta = PARAM_METADATA[param];
  // Duration fields surface a unit dropdown and render the input/slider in
  // the chosen display unit. Plain-number fields (backoffCoefficient,
  // maximumAttempts) keep the original layout.
  const isDuration = value instanceof Duration;
  const inputValue = isDuration ? value.value : value;
  // Slider bounds are configured in ms for duration fields; scale them down
  // to the chosen display unit so the slider tracks the input. Whole numbers
  // only (regardless of unit) so the slider value the user reads off the UI
  // matches whatever unit they selected without trailing decimals.
  const unitFactor = isDuration ? value.toMilliseconds() / value.value || 1 : 1;
  const scale = isDuration
    ? (msValue) => (msValue == null ? msValue : msValue / unitFactor)
    : (v) => v;
  const sliderMin = isDuration
    ? min
      ? Math.max(1, Math.round(scale(min)))
      : 0
    : min || 0;
  const sliderMax = isDuration ? Math.max(1, Math.round(scale(max))) : max || 100;
  const sliderStep = isDuration ? Math.max(1, Math.round(scale(step))) : step || 1;
  return (
    <div className={styles.parameter}>
      <div className={styles.inputContainer}>
        <a
          className={styles.numberInputLabel}
          href={meta.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {meta.label}
        </a>
        {/* With float: right, the element rendered first ends up rightmost. */}
        {isDuration && (
          <select
            className={styles.unitSelect}
            value={value.unit}
            onChange={(ev) => updateRetryPolicyParamUnit(param, ev.target.value)}
          >
            {DURATION_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        )}
        <input
          value={inputValue}
          onChange={(ev) => updateRetryPolicyParam(param, ev)}
          className={styles.numberInput}
          type="number"
        />
      </div>
      <div className={styles.parameterMeta}>
        <span className={styles.parameterDescription}>{meta.description}</span>
        <span className={styles.parameterDefault}>Default: {meta.defaultDisplay}</span>
      </div>
      <input
        value={inputValue}
        onChange={(ev) => updateRetryPolicyParam(param, ev)}
        type="range"
        className={styles.slider}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
      />
    </div>
  );
}

function retryPolicyCode(state) {
  const value = {
    scheduleToCloseTimeout: state.scheduleToCloseTimeout,
    startToCloseTimeout: state.startToCloseTimeout,
    scheduleToStartTimeout: state.scheduleToStartTimeout,
    retryPolicy: {
      backoffCoefficient: state.backoffCoefficient,
      initialInterval: state.initialInterval,
      maximumAttempts: state.maximumAttempts,
      maximumInterval: state.maximumInterval,
    },
  };
  if (value.retryPolicy.maximumAttempts === 0) {
    delete value.retryPolicy.maximumAttempts;
  }
  // Omit maximumInterval when it matches the SDK default (100 × initialInterval).
  if (
    value.retryPolicy.maximumInterval.toMilliseconds() ===
    100 * value.retryPolicy.initialInterval.toMilliseconds()
  ) {
    delete value.retryPolicy.maximumInterval;
  }
  if (value.scheduleToStartTimeout.toMilliseconds() === 0) {
    delete value.scheduleToStartTimeout;
  }
  if (value.scheduleToCloseTimeout.toMilliseconds() === 0) {
    delete value.scheduleToCloseTimeout;
  }
  if (value.startToCloseTimeout.toMilliseconds() === 0) {
    delete value.startToCloseTimeout;
  }
  if (state.language === "typescript") {
    // For TypeScript output, render durations in ms (the SDK contract).
    const tsValue = JSON.parse(
      JSON.stringify(value, (_, v) => (v instanceof Duration ? v.toMilliseconds() : v))
    );
    return JSON.stringify(tsValue, null, "  ");
  } else if (state.language === "go") {
    const formatGoValue = (v) =>
      v instanceof Duration ? `${v.value} * ${UNIT_TO_GO[v.unit]}` : v;
    const val = [
      "workflow.ActivityOptions{",
      ...Object.keys(value)
        .filter((key) => key !== "retryPolicy")
        .map((key) => `\t${capitalizeFirstLetter(key)}: ${formatGoValue(value[key])},`),
      "\tRetryPolicy: &temporal.RetryPolicy{",
      ...Object.keys(value.retryPolicy).map(
        (key) => `\t\t${capitalizeFirstLetter(key)}: ${formatGoValue(value.retryPolicy[key])}`
      ),
      "\t}",
      "}",
    ].join("\n");
    return val;
  }
}

function getEventValue(ev) {
  return ev && ev.target && ev.target.value;
}

function capitalizeFirstLetter(val) {
  return val[0].toUpperCase() + val.slice(1);
}
