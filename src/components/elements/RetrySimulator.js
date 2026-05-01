import Chart from "chart.js/auto";
import CodeBlock from "@theme/CodeBlock";
import React, { useState, useCallback, useEffect, useRef } from "react";
import styles from "./retry-simulator.module.css";
import { useColorMode } from "@docusaurus/theme-common";
import {
  calculateResult,
  encodeStateToParams,
  decodeStateFromParams,
} from "./retry-simulator-state.mjs";

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
  const hasHydratedFromUrl = useRef(false);
  const { colorMode } = useColorMode();
  const isDarkTheme = colorMode === 'dark';

  const addRetry = useCallback(function addRetry(success, runtimeMS) {
    const retries = [...state.retries];
    if (retries.length > 0) {
      retries[retries.length - 1] = {
        ...retries[retries.length - 1],
        success: false,
      };
    }
    const retry = { success, runtimeMS };
    retries.push(retry);

    setState({ ...state, retries });
  });

  const updateRetry = useCallback(function updateRetry(index, update) {
    const retries = [...state.retries];
    if (update.runtimeMS != null) {
      update.runtimeMS = +update.runtimeMS;
      if (isNaN(update.runtimeMS)) {
        delete update.runtimeMS;
      }
    }
    retries[index] = { ...retries[index], ...update };
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
    const requestRuntimeMS = values.requestRuntimeMS;
    const successRate = values.successRate;
    const retries = [];
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; ++i) {
      const success = Math.random() < successRate || i === maxRetries - 1;
      const runtimeMS = requestRuntimeMS + Math.round((Math.random() - 0.5) * (requestRuntimeMS / 2)); // +/- 50%
      retries.push({ success, runtimeMS });
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
    setState({ ...state, [prop]: +value });
    updateChart();
  });

  const updateChart = useCallback(function updateChart() {
    if (chartCanvas.current == null || chartCanvas.current.chart == null) {
      return;
    }
    const chart = chartCanvas.current.chart;

    const { backoffCoefficient, initialInterval } = state;
    let { maximumInterval, maximumAttempts } = state;
    const labels = [];
    const values = [];
    maximumAttempts = maximumAttempts === 0 ? 10 : maximumAttempts;
    let interval = initialInterval;
    for (let i = 0; i < maximumAttempts; ++i) {
      interval = Math.min(interval, maximumInterval);
      labels.push(i + 1);
      values.push(interval);
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
        label: "Interval after activity failure in ms",
        backgroundColor: "#84bdf5",
        borderColor: "#84bdf5",
        data: values,
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
    function updateChartDarkTheme() {
      if (chartCanvas.current == null || chartCanvas.current.chart == null) {
        return;
      }
      const chart = chartCanvas.current.chart;

      chart.options.scales.y.grid.color = isDarkTheme ? "#222" : "#ddd";
      chart.options.scales.x.grid.color = isDarkTheme ? "#222" : "#ddd";
      chart.update();
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

  useEffect(() => updateChart(), [state]);

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
            </select>
          </div>
          <div className={styles.scheduleTime}>
            <div className={styles.inputContainer}>
              <label className={styles.numberInputLabel}>Task Time in Queue</label>
              <input
                className={styles.numberInput}
                value={state.scheduleTime}
                onChange={(ev) => updateRetryPolicyParam("scheduleTime", ev)}
                type="number"
              />
            </div>
            <input
              type="range"
              value={state.scheduleTime}
              onChange={(ev) => updateRetryPolicyParam("scheduleTime", ev)}
              className={styles.slider}
              min="0"
              max="1000"
              step="5"
            />
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
          <button className={styles.addButton} onClick={() => addRetry(true, 1)}>
            + Add
          </button>
        </div>
        <div className={styles.retryCol}>
          <h3>Activity Timeouts (in ms)</h3>
          <RetryPolicyParamInputs
            param="startToCloseTimeout"
            value={state.startToCloseTimeout}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <RetryPolicyParamInputs
            param="scheduleToStartTimeout"
            value={state.scheduleToStartTimeout}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <RetryPolicyParamInputs
            param="scheduleToCloseTimeout"
            value={state.scheduleToCloseTimeout}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <h3>Retry Policy (in ms)</h3>
          <RetryPolicyParamInputs
            param="backoffCoefficient"
            value={state.backoffCoefficient}
            min={1}
            max={10}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <RetryPolicyParamInputs
            param="initialInterval"
            value={state.initialInterval}
            max={10000}
            step={50}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <RetryPolicyParamInputs
            param="maximumAttempts"
            value={state.maximumAttempts}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
          <RetryPolicyParamInputs
            param="maximumInterval"
            value={state.maximumInterval}
            max={100000}
            step={100}
            updateRetryPolicyParam={updateRetryPolicyParam}
          />
        </div>
      </div>
      <div className={styles.retryRow}>
        <div className={styles.retryCol}>
          <div className={styles.result + " " + (success ? styles.success : styles.fail)}>
            <h3 className={styles.resultText}>
              {success ? "Success" : "Failed"} after {runtimeMS} ms ({attempts}{" "}
              {attempts === 1 ? "attempt" : "attempts"})
              {success ? "" : ": " + reason}
            </h3>
          </div>
        </div>
        <div className={styles.retryCol}>
          <div>
            <CodeBlock language={state.language}>{code}</CodeBlock>
          </div>
          <div>
            <canvas ref={chartCanvas}></canvas>
          </div>
        </div>
      </div>
    </div>
  );
}

function RetryConfig({ retry, numRetries, index, updateRetry, deleteRetry }) {
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
        <input
          type="number"
          className={styles.numberInput}
          value={retry.runtimeMS}
          onChange={(ev) => updateRetry(index, { runtimeMS: ev.target.value })}
        />
        <span className={styles.removeRetry} onClick={() => deleteRetry(index)}>
          &times;
        </span>
      </div>
      <input
        type="range"
        className={styles.slider}
        value={retry.runtimeMS}
        onChange={(ev) => updateRetry(index, { runtimeMS: ev.target.value })}
        min="0"
        max="1000"
        step="5"
      />
    </div>
  );
}

const PARAM_METADATA = {
  startToCloseTimeout: {
    label: "Start-To-Close Timeout",
    description:
      "Maximum time allowed for a single Activity Task Execution. Either this or Schedule-To-Close Timeout must be set.",
    href: "https://docs.temporal.io/encyclopedia/detecting-activity-failures#start-to-close-timeout",
    defaultDisplay: "∞",
  },
  scheduleToStartTimeout: {
    label: "Schedule-To-Start Timeout",
    description:
      "Maximum time from when an Activity Task is scheduled to when a Worker picks it up.",
    href: "https://docs.temporal.io/encyclopedia/detecting-activity-failures#schedule-to-start-timeout",
    defaultDisplay: "∞",
  },
  scheduleToCloseTimeout: {
    label: "Schedule-To-Close Timeout",
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

function RetryPolicyParamInputs({ param, value, updateRetryPolicyParam, min, max, step }) {
  const meta = PARAM_METADATA[param];
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
        <input
          value={value}
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
        value={value}
        onChange={(ev) => updateRetryPolicyParam(param, ev)}
        type="range"
        className={styles.slider}
        min={min || 0}
        max={max || 100}
        step={step || 1}
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
  if (value.retryPolicy.maximumInterval === 100 * value.retryPolicy.initialInterval) {
    delete value.retryPolicy.maximumInterval;
  }
  if (value.scheduleToStartTimeout === 0) {
    delete value.scheduleToStartTimeout;
  }
  if (value.scheduleToCloseTimeout === 0) {
    delete value.scheduleToCloseTimeout;
  }
  if (state.language === "typescript") {
    return JSON.stringify(value, null, "  ");
  } else if (state.language === "go") {
    const val = [
      "workflow.ActivityOptions{",
      ...Object.keys(value)
        .filter((key) => key !== "retryPolicy")
        .map((key) => `\t${capitalizeFirstLetter(key)}: ${value[key]},`),
      "\tRetryPolicy: &temporal.RetryPolicy{",
      ...Object.keys(value.retryPolicy).map((key) => `\t\t${capitalizeFirstLetter(key)}: ${value.retryPolicy[key]}`),
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
