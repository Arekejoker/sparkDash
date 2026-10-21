/**
 * ai-mode control bridge — runs an external ai-mode binary on the host and maps
 * its status output to dashboard-friendly summaries.
 *
 * The dashboard must run as a HOST process (not in Docker) so child_process
 * inherits the user session needed by `systemctl --user`.
 */
import { spawn } from "child_process";

export const AI_MODE_ACTIONS = new Set(["deepseek", "deepseek-vision", "qwen-flash", "qwen-flash-single", "glm53", "glm53-decode", "ling", "mix", "media", "light", "embedding-on", "embedding-off", "comfyui-on", "comfyui-off", "qwen-flash-single-worker-on", "qwen-flash-single-worker-off", "status"]);

const DEFAULT_BIN = "ai-mode";

function aiModeBin() {
  return process.env.AI_MODE_BIN || DEFAULT_BIN;
}

let transitionRunning = false;

/** Most recent run (status or transition) with an in-memory line log. */
let activeRun = null;
let runSeq = 0;
const MAX_LOG_LINES = 2000;

export function isAiModeTransitionRunning() {
  return transitionRunning;
}

/**
 * Incremental log for the current (or last) run. `since` is a line index;
 * callers keep their own cursor and pass it back on each poll.
 */
export function getAiModeLogs(since = 0) {
  if (!activeRun) {
    return { runId: null, logs: [], since: 0, done: false, ok: null, code: null, error: null };
  }
  const idx = Number.isFinite(since) && since >= 0 ? Math.trunc(since) : 0;
  return {
    runId: activeRun.id,
    logs: activeRun.logs.slice(idx),
    since: idx,
    done: activeRun.done,
    ok: activeRun.ok,
    code: activeRun.code,
    error: activeRun.error,
  };
}

/** Kick off `ai-mode <action> [arg]` in the background, returning the run id. */
export function startAiModeRun(action, arg) {
  void runAiMode(action, { arg });
  return activeRun?.id ?? 0;
}

function parseStatus(output) {
  const parsed = {};
  for (const line of String(output || "").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) parsed[m[1]] = m[2];
  }
  return parsed;
}

/**
 * Run `ai-mode <action>` on the host.
 * Resolves with { action, ok, code?, output?, stderr?, error?, status? }.
 */
export function runAiMode(action, { timeoutMs, arg } = {}) {
  const bin = aiModeBin();
  if (!AI_MODE_ACTIONS.has(action)) {
    return Promise.resolve({ action, ok: false, error: `unknown action: ${action}` });
  }
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
        : action === "status"
          ? 15000
          : action === "qwen-flash" || action === "qwen-flash-single" || action === "qwen-flash-single-worker-on" || action === "deepseek-vision"
            ? 1200000
            : 900000;
  if (action !== "status" && transitionRunning) {
    return Promise.resolve({
      action,
      ok: false,
      error: "an ai-mode transition is already running",
    });
  }
  if (action !== "status") transitionRunning = true;

  // Only transitions own the log buffer; status polls must not clobber an
  // in-flight switch run so the UI can keep tailing its logs.
  let run = null;
  if (action !== "status") {
    run = {
      id: ++runSeq,
      action,
      logs: [],
      done: false,
      ok: null,
      code: null,
      error: null,
    };
    activeRun = run;
  }

  function append(chunk) {
    const text = String(chunk);
    if (action === "status") {
      statusOutput += text;
      return;
    }
    if (!run) return;
    for (const line of text.split("\n")) {
      if (line.length > 0) run.logs.push(line);
    }
    if (run.logs.length > MAX_LOG_LINES) {
      run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
    }
  }

  let statusOutput = "";

  return new Promise((resolve) => {
    const child = spawn(bin, arg ? [action, arg] : [action], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    child.stdout.on("data", (d) => append(d.toString()));
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      append(text);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      transitionRunning = false;
      if (run) {
        run.done = true;
        run.error = err.message;
      }
      resolve({ action, ok: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      transitionRunning = false;
      if (run) {
        run.done = true;
        run.ok = code === 0;
        run.code = code;
        if (timedOut) {
          run.error = `ai-mode timed out after ${Math.round(timeout / 1000)}s`;
        } else if (!run.ok && !run.error && stderr.trim()) {
          run.error = stderr.trim().split("\n").slice(-3).join("\n");
        }
      }
      const output = action === "status" ? statusOutput : run ? run.logs.join("\n") : "";
      resolve({
        action,
        ok: code === 0,
        code,
        output,
        stderr: stderr.trim(),
        status: action === "status" ? parseStatus(output) : null,
      });
    });
  });
}

const LAN_BASE = process.env.SPARKDASH_LAN_BASE || "http://localhost";

/** Client-facing endpoints + model names per mode (port layout is fixed). */
const ADDRESSES = {
  deepseek: { api: `${LAN_BASE}:8888/v1`, model: "deepseek-v4-flash-0731", comfy: null },
  "deepseek-vision": { api: `${LAN_BASE}:8888/v1`, model: "deepseek-v4-flash-vision-exp", comfy: null },
  "qwen-flash": { api: `${LAN_BASE}:8888/v1`, model: "qwen3.8-flash-next", comfy: null },
  "qwen-flash-single": { api: `${LAN_BASE}:8000/v1`, model: "qwen3.8-flash-next", comfy: null },
  mix: { api: `${LAN_BASE}:8000/v1`, model: "qwen3.8-27b", comfy: `${LAN_BASE}:8188`, embedding: `${LAN_BASE}:8011/v1` },
  media: { api: null, model: null, comfy: `${LAN_BASE}:8188`, embedding: `${LAN_BASE}:8011/v1` },
  light: { api: null, model: null, comfy: null },
  glm53: { api: `${LAN_BASE}:8888/v1`, model: "GLM-5.3-Flash-EXL3", comfy: null },
  ling: { api: `${LAN_BASE}:8000/v1`, model: "ling-3.0-flash", comfy: null },
};

export function summarizeStatus(parsed) {
  const mode = parsed?.actual_mode || parsed?.mode || "unknown";
  const stableMode = Object.prototype.hasOwnProperty.call(ADDRESSES, mode) ? mode : null;
  const addr = stableMode ? ADDRESSES[stableMode] : ADDRESSES.light;
  return {
    mode,
    storedMode: parsed?.stored_mode || null,
    desiredMode: parsed?.desired_mode || null,
    actualMode: parsed?.actual_mode || mode,
    transitionState: parsed?.transition_state || "unknown",
    lastError: parsed?.last_error || null,
    qwenError: parsed?.qwen_error || null,
    qwenFlashError: parsed?.qwen_flash_error || null,
    qwenFlashSingleLocalError: parsed?.qwen_flash_single_local_error || null,
    embeddingDesired: parsed?.embedding_desired || "unknown",
    embeddingActual: parsed?.embedding_actual || "unknown",
    glm53Decode: parsed?.glm53_decode || "unknown",
    health: {
      deepseek: parsed?.deepseek === "healthy",
      deepseekVision: parsed?.deepseek_vision === "healthy",
      qwen: parsed?.qwen === "healthy",
      qwenFlash: parsed?.qwen_flash === "healthy",
      qwenFlashSingleLocal: parsed?.qwen_flash_single_local === "healthy",
      comfyui: parsed?.comfyui === "healthy",
      pixelle: parsed?.pixelle === "healthy",
      nemotron: parsed?.nemotron === "healthy",
      glm53: parsed?.glm53 === "healthy",
      ling: parsed?.ling === "healthy",
    },
    // Worker single-Spark service: an independent toggle, not a local mode.
    remoteSingle: {
      up: parsed?.qwen_flash_single_worker === "healthy",
      error: parsed?.qwen_flash_single_worker_error || null,
      clientUrl: parsed?.qwen_flash_single_worker_client_url || null,
      model: "qwen3.8-flash-next",
      workerBusyDualNode: parsed?.qwen_flash_single_worker_busy === "yes",
    },
    api: addr.api,
    model: addr.model,
    comfy: addr.comfy,
    embedding: addr.embedding ?? null,
  };
}
