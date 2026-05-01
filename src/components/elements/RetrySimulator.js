import Chart from "chart.js/auto";
import CodeBlock from "@theme/CodeBlock";
import React, { useState, useEffect, useRef } from "react";
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
  formatDurationLong,
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

// Doc anchors for each Activity terminal event type.
const EVENT_TYPE_DOCS_URL = {
  ActivityTaskCompleted: "/references/events#activitytaskcompleted",
  ActivityTaskFailed: "/references/events#activitytaskfailed",
  ActivityTaskTimedOut: "/references/events#activitytasktimedout",
};

// Hard upper bound on bars rendered in either chart. Beyond this, individual
// attempts get unreadably small; the simulation still tracks the actual count.
const SLOT_CAP = 100;

// Stable React keys for retry rows. We can't use array index — deleting retry
// N would alias retry N+1 onto the deleted row's local component state
// (stashedCount/stashedPeriod in RetryConfig). _key is not encoded into the
// URL since encodeRetries only reads success/runtime/count/period.
let nextRetryKey = 1;
function withRetryKey(retry) {
  return retry._key != null ? retry : { ...retry, _key: nextRetryKey++ };
}
function withRetryKeys(retries) {
  return retries.map(withRetryKey);
}

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

// High-level outcome shown in the Status row. Specifics (which timeout fired,
// which event type, etc.) are surfaced separately in the Result and Details
// rows, so this stays to one of: Success, Timed Out, Failed, Never terminates.
function resultStatusLabel(success, reason, lastAttemptOutcome) {
  if (success === null) return "Never terminates";
  if (success === true) return "Success";
  if (
    reason === "scheduleToCloseTimeout" ||
    reason === "scheduleTime" ||
    lastAttemptOutcome === "timedOut"
  ) {
    return "Timed Out";
  }
  return "Failed";
}

// The Workflow History event that the Server records for the activity's
// terminal outcome. Mirrors the per-attempt OUTCOME_EVENT_TYPE mapping but
// also accounts for chain-end reasons that fire before any attempt runs (e.g.
// scheduleToStartTimeout).
function resultEventType(success, reason, lastAttemptOutcome) {
  if (success === null) return null;
  if (success === true) return "ActivityTaskCompleted";
  if (reason === "scheduleToCloseTimeout" || reason === "scheduleTime") {
    return "ActivityTaskTimedOut";
  }
  // For maximumAttempts / activity-reported failures, the event mirrors the
  // last attempt's outcome — a startToCloseTimeout-killed attempt records as
  // ActivityTaskTimedOut even when the chain ended via maximumAttempts.
  if (lastAttemptOutcome === "timedOut") return "ActivityTaskTimedOut";
  return "ActivityTaskFailed";
}

// Whichever timeout/limit ended the retry chain — used to render the Details
// row as a link to the relevant docs page. Returns null when there's nothing
// useful to surface (success, never-terminates).
function resultDetailsLink(success, reason, lastAttemptOutcome) {
  if (success !== false) return null;
  if (reason === "scheduleToCloseTimeout") {
    return {
      label: "Exceeded Schedule-To-Close Timeout",
      href: "/encyclopedia/detecting-activity-failures#schedule-to-close-timeout",
    };
  }
  if (reason === "scheduleTime") {
    return {
      label: "Exceeded Schedule-To-Start Timeout",
      href: "/encyclopedia/detecting-activity-failures#schedule-to-start-timeout",
    };
  }
  if (reason === "maximumAttempts") {
    // If the final attempt was killed by startToCloseTimeout, that is the
    // proximate cause the user usually wants to read about — point at the
    // timeout doc instead of the (also-true) maximumAttempts cap.
    if (lastAttemptOutcome === "timedOut") {
      return {
        label: "Exceeded Start-To-Close Timeout",
        href: "/encyclopedia/detecting-activity-failures#start-to-close-timeout",
      };
    }
    return {
      label: "Exceeded Maximum Attempts",
      href: "/encyclopedia/retry-policies#maximum-attempts",
    };
  }
  return null;
}

const LANGUAGE_SAMPLES = {
  typescript: `
import axios from 'axios';

async function testActivity(url: string): Promise<void> {
  await axios.get(url);
}

export default testActivity;
`.trim(),
  go: `
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
`.trim(),
};

function withKeyedRetries(state) {
  return { ...state, retries: withRetryKeys(state.retries) };
}

function updateChart(chart, state, result) {
  const { backoffCoefficient, maximumAttempts } = state;
  const initialInterval = state.initialInterval.toMilliseconds();
  const maximumInterval = state.maximumInterval.toMilliseconds();
  const labels = [];
  const values = [];
  // Each bar is colored by what actually happened on that attempt (succeeded /
  // failed / timed out) or grayed out for slots the activity never reached.
  const baseSlots = maximumAttempts === 0 ? 10 : Math.min(maximumAttempts, 30);
  // When the activity terminates, grow the chart to cover every attempt that
  // actually ran so the user can see the full retry sequence. For the
  // never-terminates branch (result.success === null) we keep the baseline
  // slot count — there's no meaningful "all attempts" to show.
  const slots =
    result.success !== null
      ? Math.min(SLOT_CAP, Math.max(baseSlots, result.attempts))
      : baseSlots;
  let interval = initialInterval;
  const colors = [];
  for (let i = 0; i < slots; ++i) {
    interval = Math.min(interval, maximumInterval);
    labels.push(i + 1);
    values.push(interval);
    colors.push(OUTCOME_COLORS[result.attemptTimeline[i]?.outcome] || OUTCOME_COLORS.notUsed);
    interval = interval * backoffCoefficient;
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
}

function updateTimeline(chart, state, result) {
  const timeline = result.attemptTimeline;
  const labels = timeline.map((_, i) => i + 1);
  // Floating bars: each data point is [start, end] in ms. Chart.js renders
  // them as horizontal spans on the wall-clock X-axis when indexAxis is "y".
  const data = timeline.map((a) => [a.startMS, a.startMS + a.elapsedMS]);
  const colors = timeline.map((a) => OUTCOME_COLORS[a.outcome] || OUTCOME_COLORS.notUsed);

  chart.$scheduleToCloseTimeoutMS = state.scheduleToCloseTimeout.toMilliseconds();
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
      // Make zero-elapsed-time attempts visible.
      minBarLength: 4,
    },
  ];
  chart.update();
}

export default function RetrySimulator() {
  const [state, setState] = useState(() => withKeyedRetries(decodeStateFromParams("")));
  const chartCanvas = useRef(null);
  const timelineCanvas = useRef(null);
  const persistEffectHasRun = useRef(false);
  const { colorMode } = useColorMode();
  const isDarkTheme = colorMode === 'dark';

  function addRetry() {
    const retries = [...state.retries];
    if (retries.length > 0) {
      retries[retries.length - 1] = {
        ...retries[retries.length - 1],
        success: false,
      };
    }
    retries.push(withRetryKey({ success: true, runtime: new Duration(1, "s") }));
    setState({ ...state, retries });
  }

  function updateRetry(index, rawUpdate) {
    const update = { ...rawUpdate };
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
  }

  function deleteRetry(index) {
    const retries = [...state.retries];
    retries.splice(index, 1);
    setState({ ...state, retries });
  }

  function applyRetryScenario(values) {
    if (!values) {
      return;
    }
    values = JSON.parse(values);

    if (values.scenario === "outage") {
      const period = new Duration(values.periodValue, values.periodUnit);
      setState({
        ...state,
        retries: withRetryKeys([
          { success: false, runtime: new Duration(100, "ms"), period },
          { success: true, runtime: new Duration(100, "ms") },
        ]),
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
        retries: withRetryKeys([
          { success: true, runtime: new Duration(5, "s"), period },
          { success: true, runtime: new Duration(100, "ms") },
        ]),
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

    setState({ ...state, retries: withRetryKeys(retries) });
  }

  function updateRetryPolicyParam(prop, ev) {
    const next = +ev.target.value;
    if (isNaN(next)) return;
    const current = state[prop];
    // Duration fields keep their selected unit when the numeric value changes.
    const update = current instanceof Duration ? current.withValue(next) : next;
    setState({ ...state, [prop]: update });
  }

  function updateRetryPolicyParamUnit(prop, unit) {
    setState({ ...state, [prop]: state[prop].withUnit(unit) });
  }

  function updateLanguage(language) {
    setState({ ...state, language });
  }

  // Single simulation per render, shared by the result panel and both charts.
  const result = calculateResult(state);
  const { success, runtimeMS, reason, attempts, lastAttemptOutcome } = result;
  const code = retryPolicyCode(state);
  const eventType = resultEventType(success, reason, lastAttemptOutcome);
  const detailsLink = resultDetailsLink(success, reason, lastAttemptOutcome);

  useEffect(function initializeChart() {
    const chart = new Chart(chartCanvas.current, {
      type: "bar",
      options: {
        responsive: true,
        scales: {
          y: { grid: { color: "#ddd" } },
          x: { grid: { color: "#ddd" } },
        },
      },
    });
    chartCanvas.current.chart = chart;
    return () => {
      chart.destroy();
      if (chartCanvas.current) chartCanvas.current.chart = null;
    };
  }, []);

  useEffect(function initializeTimelineChart() {
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
    return () => {
      chart.destroy();
      if (timelineCanvas.current) timelineCanvas.current.chart = null;
    };
  }, []);

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
    setState(withKeyedRetries(decodeStateFromParams(window.location.search)));
  }, []);

  useEffect(function persistStateToUrl() {
    // Skip the first run so we don't briefly clobber the URL with
    // empty params before loadStateFromUrl's setState has been applied.
    if (!persistEffectHasRun.current) {
      persistEffectHasRun.current = true;
      return;
    }
    const params = encodeStateToParams(state);
    const query = params.toString();
    const newUrl =
      window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, [state]);

  // Redraw both charts whenever state changes. result is derived from state,
  // so depending on state alone keeps this effect from firing on every render.
  useEffect(() => {
    if (chartCanvas.current?.chart) updateChart(chartCanvas.current.chart, state, result);
    if (timelineCanvas.current?.chart) updateTimeline(timelineCanvas.current.chart, state, result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              {LANGUAGE_SAMPLES[state.language]}
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
            {state.retries.map((retry, index) => (
              <RetryConfig
                retry={retry}
                numRetries={state.retries.length}
                index={index}
                updateRetry={updateRetry}
                deleteRetry={deleteRetry}
                key={retry._key}
              />
            ))}
          </div>
          <button className={styles.addButton} onClick={() => addRetry()}>
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
            param="maximumInterval"
            value={state.maximumInterval}
            min={state.initialInterval.toMilliseconds()}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
          <RetryPolicyParamInputs
            param="maximumAttempts"
            value={state.maximumAttempts}
            updateRetryPolicyParam={updateRetryPolicyParam}
            updateRetryPolicyParamUnit={updateRetryPolicyParamUnit}
          />
        </div>
      </div>
      <div className={styles.retryRow}>
        <div className={styles.retryCol}>
          <div className={styles.result + " " + (success === true ? styles.success : styles.fail)}>
            <div className={styles.resultRow}>
              <span className={styles.resultLabel}>Status</span>
              <span className={styles.resultValue}>{resultStatusLabel(success, reason, lastAttemptOutcome)}</span>
            </div>
            {eventType && (
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>Result</span>
                <span className={styles.resultValue}>
                  <a href={EVENT_TYPE_DOCS_URL[eventType]} target="_blank" rel="noopener noreferrer">
                    {eventType}
                  </a>
                </span>
              </div>
            )}
            {detailsLink && (
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>Details</span>
                <span className={styles.resultValue}>
                  <a href={detailsLink.href} target="_blank" rel="noopener noreferrer">
                    {detailsLink.label}
                  </a>
                </span>
              </div>
            )}
            {success === null && (
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>Details</span>
                <span className={styles.resultValue}>
                  Set a <a href="/encyclopedia/detecting-activity-failures#schedule-to-close-timeout" target="_blank" rel="noopener noreferrer">Schedule-To-Close Timeout</a>
                  {" "}or <a href="/encyclopedia/retry-policies#maximum-attempts" target="_blank" rel="noopener noreferrer">Maximum Attempts</a> to bound the number of attempts.
                </span>
              </div>
            )}
            <div className={styles.resultRow}>
              <span className={styles.resultLabel}>Time Elapsed</span>
              <span className={styles.resultValue}>
                {success === null ? "∞" : formatDurationLong(runtimeMS)}
              </span>
            </div>
            <div className={styles.resultRow}>
              <span className={styles.resultLabel}>Attempts</span>
              <span className={styles.resultValue}>{success === null ? "∞" : attempts}</span>
            </div>
          </div>
        </div>
        <div className={styles.retryCol}>
          <canvas ref={chartCanvas}></canvas>
        </div>
      </div>
      <div className={styles.timelineSection}>
        <h3>Attempt Timeline</h3>
        <canvas ref={timelineCanvas}></canvas>
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
    <div className={styles.retry}>
      <div className={styles.inputContainer}>
        <select
          className={styles.numberInputLabel}
          disabled={index + 1 < numRetries}
          value={retry.success ? "succeeds" : "fails"}
          onChange={(ev) => updateRetry(index, { success: ev.target.value === "succeeds" })}
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
        <button
          type="button"
          className={styles.removeRetry}
          onClick={() => deleteRetry(index)}
          aria-label="Remove this retry"
        >
          &times;
        </button>
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
                : `attempts, avg ${runtime.value}${runtime.unit} each`}
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
    href: "/encyclopedia/detecting-activity-failures#start-to-close-timeout",
    defaultDisplay: "∞",
  },
  scheduleToStartTimeout: {
    label: "Schedule-To-Start",
    description:
      "Maximum time from when an Activity Task is scheduled to when a Worker picks it up.",
    href: "/encyclopedia/detecting-activity-failures#schedule-to-start-timeout",
    defaultDisplay: "∞",
  },
  scheduleToCloseTimeout: {
    label: "Schedule-To-Close",
    description:
      "Maximum time for the overall Activity Execution, from first scheduling to last completion.",
    href: "/encyclopedia/detecting-activity-failures#schedule-to-close-timeout",
    defaultDisplay: "∞",
  },
  backoffCoefficient: {
    label: "Backoff Coefficient",
    description: "Multiplier applied to each successive retry interval.",
    href: "/encyclopedia/retry-policies#backoff-coefficient",
    defaultDisplay: "2",
  },
  initialInterval: {
    label: "Initial Interval",
    description: "Amount of time that must elapse before the first retry occurs.",
    href: "/encyclopedia/retry-policies#initial-interval",
    defaultDisplay: "1000ms",
  },
  maximumAttempts: {
    label: "Maximum Attempts",
    description:
      "Maximum number of execution attempts that can be made in the presence of failures (0 means unlimited).",
    href: "/encyclopedia/retry-policies#maximum-attempts",
    defaultDisplay: "∞",
  },
  maximumInterval: {
    label: "Maximum Interval",
    description: "Upper bound on the interval between retries.",
    href: "/encyclopedia/retry-policies#maximum-interval",
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
  const isDuration = value instanceof Duration;
  const inputValue = isDuration ? value.value : value;
  // For Duration fields the slider/input bounds arrive in ms; rescale them
  // to whatever display unit the user picked. The `|| 1` guards value=0.
  const unitFactor = isDuration ? value.toMilliseconds() / value.value || 1 : 1;
  const scale = isDuration ? (ms) => ms / unitFactor : (v) => v;
  const sliderMin = isDuration ? (min ? Math.max(1, Math.round(scale(min))) : 0) : min || 0;
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
          min={sliderMin}
          max={sliderMax}
          step={sliderStep}
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
      maximumInterval: state.maximumInterval,
      maximumAttempts: state.maximumAttempts,
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
        (key) => `\t\t${capitalizeFirstLetter(key)}: ${formatGoValue(value.retryPolicy[key])},`
      ),
      "\t},",
      "}",
    ].join("\n");
    return val;
  }
}

function capitalizeFirstLetter(val) {
  return val[0].toUpperCase() + val.slice(1);
}
