/**
 * EvalScopeRunner — background job manager for EvalScope CLI runs.
 *
 * EvalScope (its own venv) is the evaluation engine; sparkDash only spawns it,
 * streams logs and reads back the reports. One job at a time keeps a single
 * target endpoint from being hammered by a second run.
 *
 * Job state:
 *   - in memory (active job + bounded history)
 *   - config/evalscope-active.json  (in-flight checkpoint across restarts)
 *   - config/evalscope-jobs.json    (finished summaries, gitignored)
 *   - config/eval-logs/<jobId>.log  (full transcript)
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  EVALESCOPE_BIN,
  EVALESCOPE_OUTPUTS_DIR,
  EVAL_JOBS_PATH,
  EVAL_ACTIVE_PATH,
  EVAL_JOB_LOG_DIR,
  EVAL_JOB_TIMEOUT_MS,
} from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const HISTORY_LIMIT = 20;
const MAX_LOG_LINES = 4000;
/** Tail lines returned to the UI per poll. */
export const JOB_LOG_TAIL = 400;
const KILL_GRACE_MS = 5000;

export const EVAL_SCOPE_DEFAULTS = {
  datasetSuggestions: ["gsm8k", "arc", "ceval", "ifeval", "mmlu_pro", "math_500"],
  perfDatasetSuggestions: ["openqa", "random"],
  parallelSuggestions: [1, 4, 8, 16, 32],
  defaultLimit: 50,
  defaultMaxTokens: 256,
  minTokens: 32,
};

/** Turn a failed run's log tail into something actionable for the UI. */
export function extractActionableError(lines) {
  const arr = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === "string" && l.trim());
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (!/(ImportError|ModuleNotFoundError):/.test(arr[i])) continue;
    const hint = arr
      .slice(i, i + 3)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return hint.slice(0, 300);
  }
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (/Please run `?pip install/.test(arr[i])) return arr[i].trim().slice(0, 300);
    if (/\bERROR\b/.test(arr[i])) return arr[i].trim().slice(0, 300);
  }
  return null;
}

/**
 * Build the EvalScope CLI argv for one job.
 *
 * Exported (pure) so tests can lock the flag set without spawning anything.
 *
 * @param {{
 *   kind: "eval" | "perf",
 *   conn: { model: string, baseUrl: string, apiKey: string, tokenizerPath?: string|null },
 *   params: object,
 *   outputsDir: string,
 * }} input
 * @returns {string[]}
 */
export function buildEvalScopeArgs({ kind, conn, params, outputsDir }) {
  const p = params || {};
  const args = [];

  if (kind === "eval") {
    const datasets = (Array.isArray(p.datasets) ? p.datasets : [])
      .map((d) => String(d).trim())
      .filter(Boolean);
    if (!datasets.length) {
      throw Object.assign(new Error("at least one dataset is required"), { status: 400 });
    }
    const evalType =
      conn.apiType === "openai_responses" ? "openai_responses_api" : "openai_api";
    args.push(
      "eval",
      "--model", conn.model,
      "--api-url", conn.baseUrl,
      "--api-key", conn.apiKey,
      "--eval-type", evalType,
      "--datasets", ...datasets,
      "--work-dir", outputsDir
    );
    const limit = Number(p.limit);
    if (Number.isInteger(limit) && limit > 0) args.push("--limit", String(limit));
    // Streaming by default: reasoning models can think for minutes before the
    // first byte, which trips proxy/idle timeouts on non-streaming requests.
    const generationConfig =
      p.generationConfig && typeof p.generationConfig === "object" ? p.generationConfig : {};
    args.push("--generation-config", JSON.stringify({ stream: true, ...generationConfig }));
    // Extra non-secret request headers reach the OpenAI client via default_headers
    // (EvalScope forwards --model-args straight into OpenAI(**model_args)).
    const headers = conn.headers && typeof conn.headers === "object" ? conn.headers : null;
    if (headers && Object.keys(headers).length) {
      args.push("--model-args", JSON.stringify({ default_headers: headers }));
    }
    if (p.ignoreErrors) args.push("--ignore-errors");
    return args;
  }

  if (kind === "perf") {
    const dataset = String(p.dataset || "openqa").trim() || "openqa";
    const parallel = (Array.isArray(p.parallel) ? p.parallel : [1])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!parallel.length) {
      throw Object.assign(new Error("parallel must contain positive integers"), { status: 400 });
    }
    let number = (Array.isArray(p.number) ? p.number : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (number.length !== parallel.length) {
      // Default: 2 requests per client at each concurrency level.
      number = parallel.map((n) => n * 2);
    }

    if (dataset === "random" && !conn.tokenizerPath) {
      throw Object.assign(
        new Error("random dataset needs a tokenizerPath on the model entry"),
        { status: 400 }
      );
    }

    const isResponses = conn.apiType === "openai_responses";
    args.push(
      "perf",
      "--model", conn.model,
      "--url", `${conn.baseUrl.replace(/\/+$/, "")}${isResponses ? "/responses" : "/chat/completions"}`,
      "--api", isResponses ? "openai_responses" : "openai",
      "--api-key", conn.apiKey,
      "--dataset", dataset,
      "--parallel", ...parallel.map(String),
      "-n", ...number.map(String),
      "--outputs-dir", outputsDir
    );
    if (conn.tokenizerPath && dataset === "random") {
      args.push("--tokenizer-path", conn.tokenizerPath);
    }
    const maxTokens = Number(p.maxTokens);
    if (Number.isInteger(maxTokens) && maxTokens > 0) args.push("--max-tokens", String(maxTokens));
    const minTokens = Number(p.minTokens);
    if (Number.isInteger(minTokens) && minTokens > 0) args.push("--min-tokens", String(minTokens));
    // perf takes raw key=value header pairs (ParseKVAction, split on first '=').
    if (conn.headers && typeof conn.headers === "object") {
      const pairs = Object.entries(conn.headers)
        .filter(([k, v]) => k && v)
        .map(([k, v]) => `${k}=${v}`);
      if (pairs.length) args.push("--headers", ...pairs);
    }
    if (p.extraArgs && typeof p.extraArgs === "object") {
      args.push("--extra-args", JSON.stringify(p.extraArgs));
    }
    return args;
  }

  throw Object.assign(new Error(`unsupported job kind: ${kind}`), { status: 400 });
}

/** Replace key material before anything is persisted or shown. */
export function redactArgs(args, apiKey) {
  const secret = String(apiKey || "");
  return args.map((a) => (secret && a.includes(secret) ? a.split(secret).join("***") : a));
}

/** Extract the report dir EvalScope announced on stdout, if any. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sniffReportDir(line, outputsDir) {
  const re = new RegExp(`${escapeRegExp(outputsDir)}[^\\s'"]*`);
  const m = String(line).match(re);
  if (!m) return null;
  let p = m[0].replace(/[),.;:]+$/, "");
  // Lines like "HTML report generated: …/perf_report.html" point at a file.
  if (/\.[a-z0-9]+$/i.test(path.basename(p))) {
    p = path.dirname(p);
  }
  return p && fs.existsSync(p) ? p : null;
}

export class EvalScopeRunner {
  /**
   * @param {object} [opts]
   */
  constructor(opts = {}) {
    this.binPath = opts.binPath || EVALESCOPE_BIN;
    this.outputsDir = opts.outputsDir || EVALESCOPE_OUTPUTS_DIR;
    this.jobsPath = opts.jobsPath || EVAL_JOBS_PATH;
    this.activePath = opts.activePath || EVAL_ACTIVE_PATH;
    this.logDir = opts.logDir || EVAL_JOB_LOG_DIR;
    this.timeoutMs = opts.timeoutMs || EVAL_JOB_TIMEOUT_MS;

    /** @type {object | null} */
    this.active = null;
    /** @type {object[]} */
    this.history = [];
    /** @type {string[]} */
    this.logBuffer = [];
    this._logLines = 0;
    this._child = null;
    this._killTimer = null;
    this._timeoutTimer = null;

    this._loadHistory();
    this._loadActiveCheckpoint();
  }

  // ─── persistence ───────────────────────────────────────
  _loadHistory() {
    try {
      if (!fs.existsSync(this.jobsPath)) return;
      const data = JSON.parse(fs.readFileSync(this.jobsPath, "utf8"));
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      this.history = jobs
        .filter((j) => j && typeof j.jobId === "string")
        .slice(0, HISTORY_LIMIT);
    } catch (err) {
      console.warn(`[EvalScope] failed to load job history: ${err.message}`);
    }
  }

  _saveHistory() {
    try {
      atomicWrite(this.jobsPath, JSON.stringify({ version: 1, jobs: this.history }, null, 2), 0o644);
    } catch (err) {
      console.warn(`[EvalScope] failed to save job history: ${err.message}`);
    }
  }

  _loadActiveCheckpoint() {
    try {
      if (!fs.existsSync(this.activePath)) return;
      const data = JSON.parse(fs.readFileSync(this.activePath, "utf8"));
      const job = data?.job;
      if (!job || !job.jobId) return;
      // A checkpoint at boot means the process died mid-run: keep it as failed
      // history instead of an eternal "running" ghost.
      job.status = job.status === "running" ? "failed" : job.status;
      job.error = job.error || "Interrupted — server restarted while the job was running";
      job.completedAt = job.completedAt || Date.now();
      job.durationMs = job.durationMs || Math.max(0, job.completedAt - (job.startedAt || job.completedAt));
      this.history.unshift(job);
      this.history = this.history.slice(0, HISTORY_LIMIT);
      this._saveHistory();
      fs.rmSync(this.activePath, { force: true });
    } catch (err) {
      console.warn(`[EvalScope] failed to recover active checkpoint: ${err.message}`);
    }
  }

  _checkpointActive(job) {
    try {
      if (job) {
        atomicWrite(this.activePath, JSON.stringify({ version: 1, job }, null, 2), 0o644);
      } else {
        fs.rmSync(this.activePath, { force: true });
      }
    } catch (err) {
      console.warn(`[EvalScope] failed to checkpoint active job: ${err.message}`);
    }
  }

  // ─── public API ────────────────────────────────────────
  getActive() {
    return this.active ? { ...this.active } : null;
  }

  /** Active job plus the recent log tail (UI polls this). */
  getActiveWithLogs() {
    if (!this.active) return null;
    return {
      ...this.active,
      logTail: this.logBuffer.slice(-JOB_LOG_TAIL),
    };
  }

  listJobs() {
    return {
      active: this.active ? { ...this.active } : null,
      jobs: this.history.map((j) => ({ ...j })),
      defaults: EVAL_SCOPE_DEFAULTS,
    };
  }

  getJob(jobId) {
    if (this.active && this.active.jobId === jobId) {
      return { ...this.active, logTail: this.logBuffer.slice(-JOB_LOG_TAIL) };
    }
    const found = this.history.find((j) => j.jobId === jobId);
    return found ? { ...found } : null;
  }

  readLogTail(jobId, lines = JOB_LOG_TAIL) {
    const logPath = path.join(this.logDir, `${jobId}.log`);
    try {
      if (!fs.existsSync(logPath)) return [];
      const content = fs.readFileSync(logPath, "utf8");
      return content.split("\n").slice(-lines);
    } catch {
      return [];
    }
  }

  /**
   * Start a job.
   * @param {{
   *   kind: "eval" | "perf",
   *   model: { id: string, label: string, baseUrl: string, model: string, apiKey: string, tokenizerPath?: string|null, proxy?: string|null },
   *   params: object,
   * }} input
   */
  start({ kind, model, params }) {
    if (this.active) {
      throw Object.assign(new Error("an eval job is already running"), { status: 409 });
    }
    if (!fs.existsSync(this.binPath)) {
      throw Object.assign(
        new Error(`EvalScope CLI not found at ${this.binPath} (set EVALESCOPE_BIN)`),
        { status: 500 }
      );
    }

    fs.mkdirSync(this.outputsDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const args = buildEvalScopeArgs({
      kind,
      conn: model,
      params: params || {},
      outputsDir: this.outputsDir,
    });
    const redacted = redactArgs(args, model.apiKey);
    const jobId = randomUUID();
    const startedAt = Date.now();

    /** @type {object} */
    const job = {
      jobId,
      kind,
      modelId: model.id,
      modelLabel: model.label || model.id,
      status: "running",
      startedAt,
      completedAt: null,
      durationMs: 0,
      exitCode: null,
      error: null,
      params: {
        datasets: Array.isArray(params?.datasets) ? params.datasets : [],
        limit: params?.limit ?? null,
        parallel: Array.isArray(params?.parallel) ? params.parallel : null,
        number: Array.isArray(params?.number) ? params.number : null,
        maxTokens: params?.maxTokens ?? null,
        minTokens: params?.minTokens ?? null,
        dataset: params?.dataset ?? null,
        extraArgs: params?.extraArgs ?? null,
      },
      commandPreview: `${this.binPath} ${redacted.join(" ")}`,
      logPath: path.join(this.logDir, `${jobId}.log`),
      logLines: 0,
      reportDir: null,
    };

    this.active = job;
    this.logBuffer = [];
    this._logLines = 0;
    this._checkpointActive(job);

    const env = { ...process.env };
    const proxy = model.proxy || process.env.EVAL_DEFAULT_PROXY || "";
    if (proxy) {
      env.HTTP_PROXY = proxy;
      env.HTTPS_PROXY = proxy;
      env.ALL_PROXY = proxy;
      // Keep LAN/vLLM endpoints off the proxy even when the service has no
      // proxy env of its own.
      const noProxy = new Set(
        String(env.NO_PROXY || env.no_proxy || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      for (const host of [
        "localhost",
        "127.0.0.1",
        "::1",
        "192.168.0.0/16",
        "10.0.0.0/8",
        "172.16.0.0/12",
      ]) {
        noProxy.add(host);
      }
      env.NO_PROXY = [...noProxy].join(",");
      env.no_proxy = env.NO_PROXY;
    }

    const header = `# ${new Date(startedAt).toISOString()} ${job.commandPreview}\n`;
    fs.writeFileSync(job.logPath, header, { mode: 0o644 });

    let child;
    try {
      child = spawn(this.binPath, args, {
        cwd: this.outputsDir,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this._finalize(job, { status: "failed", error: err.message });
      throw Object.assign(new Error(`failed to start EvalScope: ${err.message}`), { status: 500 });
    }
    this._child = child;

    const onLine = (line) => {
      if (!line) return;
      this._logLines += 1;
      this.logBuffer.push(line);
      if (this.logBuffer.length > MAX_LOG_LINES) {
        this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG_LINES);
      }
      job.logLines = this._logLines;
      if (!job.reportDir) {
        const sniffed = sniffReportDir(line, this.outputsDir);
        if (sniffed && fs.existsSync(sniffed)) job.reportDir = sniffed;
      }
      try {
        fs.appendFileSync(job.logPath, line + "\n");
      } catch {
        /* log file is best-effort */
      }
    };

    const attach = (stream) => {
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      stream.on("end", () => {
        if (buf) onLine(buf);
      });
    };
    attach(child.stdout);
    attach(child.stderr);

    this._timeoutTimer = setTimeout(() => {
      this._cancelJob(job, `Timed out after ${Math.round(this.timeoutMs / 1000)}s`);
    }, this.timeoutMs);
    if (this._timeoutTimer.unref) this._timeoutTimer.unref();

    child.on("error", (err) => {
      this._finalize(job, { status: "failed", error: err.message });
    });

    child.on("close", (code, signal) => {
      const cancelled = job.status === "cancelling";
      let status = "completed";
      if (cancelled) status = "cancelled";
      else if (code !== 0) status = "failed";
      const hint = status === "failed" ? extractActionableError(this.logBuffer) : null;
      this._finalize(job, {
        status,
        exitCode: code,
        error:
          job.error ||
          (status === "failed"
            ? hint || `EvalScope exited with code ${code}${signal ? ` (${signal})` : ""} — see log`
            : null),
      });
    });

    return { ...job };
  }

  /** @param {string} jobId */
  cancel(jobId) {
    if (!this.active || this.active.jobId !== jobId) {
      throw Object.assign(new Error("job is not running"), { status: 404 });
    }
    this._cancelJob(this.active, "Cancelled by user");
    return { ...this.active };
  }

  _cancelJob(job, reason) {
    if (!job || job.status !== "running") return;
    job.status = "cancelling";
    job.error = reason;
    const child = this._child;
    if (child && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      this._killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS);
      if (this._killTimer.unref) this._killTimer.unref();
    } else {
      this._finalize(job, { status: "cancelled", error: reason });
    }
  }

  _finalize(job, patch) {
    if (job._finalized) return;
    job._finalized = true;

    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    this._child = null;

    job.status = patch.status;
    job.exitCode = patch.exitCode ?? job.exitCode ?? null;
    job.error = patch.error ?? job.error ?? null;
    job.completedAt = Date.now();
    job.durationMs = Math.max(0, job.completedAt - job.startedAt);

    if (this.active && this.active.jobId === job.jobId) {
      this.active = null;
      this._checkpointActive(null);
    }

    const clean = { ...job };
    delete clean._finalized;
    this.history.unshift(clean);
    this.history = this.history.slice(0, HISTORY_LIMIT);
    this._saveHistory();

    try {
      fs.appendFileSync(
        job.logPath,
        `\n# finished status=${job.status} exit=${job.exitCode} duration=${Math.round(job.durationMs / 1000)}s\n`
      );
    } catch {
      /* best-effort */
    }
  }

  /** Shutdown hook: terminate the in-flight job before exit. */
  interruptAll(reason = "Interrupted — server shutting down") {
    if (this.active) this._cancelJob(this.active, reason);
  }
}

export const evalScopeRunner = new EvalScopeRunner();
