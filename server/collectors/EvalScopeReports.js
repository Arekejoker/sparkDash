/**
 * EvalScopeReports — read the EvalScope outputs root and normalize both
 * report families into one shape for the dashboard:
 *
 *   accuracy (eval):  <ts>/reports/<model>/<dataset>.json
 *   speed    (perf):  <ts>/<model>/parallel_<p>_number_<n>/benchmark_summary.json
 *
 * A "report" is identified by its model directory relative to the outputs
 * root (<ts>/<model>), which is unique per run.
 */
import fs from "fs";
import path from "path";
import { EVALESCOPE_OUTPUTS_DIR } from "../config.js";

const MAX_SCAN_DIRS = 200;
const CACHE_TTL_MS = 5000;

/** @type {{at: number, key: string, reports: object[]} | null} */
let _cache = null;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Parse "20260924_111457" (local time) → epoch ms. */
function parseTimestamp(name) {
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── perf ─────────────────────────────────────────────────
function parsePerfLevel(dirPath) {
  const summary = readJson(path.join(dirPath, "benchmark_summary.json"));
  if (!summary) return null;
  const percentile = readJson(path.join(dirPath, "benchmark_percentile.json"));
  const pick = (pct) => {
    if (!Array.isArray(percentile)) return null;
    const row = percentile.find((r) => String(r?.Percentiles) === pct);
    return row ? num(row["TTFT (ms)"]) : null;
  };
  const parallelMatch = path.basename(dirPath).match(/^parallel_(\d+)_number_(\d+)$/);
  return {
    level: parallelMatch ? `×${parallelMatch[1]} · ${parallelMatch[2]} req` : path.basename(dirPath),
    concurrency: num(summary["Concurrency"]),
    total: num(summary["Total Requests"]),
    success: num(summary["Success Requests"]),
    failed: num(summary["Failed Requests"]),
    rps: num(summary["Req Throughput (req/s)"]),
    latencyAvgS: num(summary["Avg Latency (s)"]),
    ttftAvgMs: num(summary["Avg TTFT (ms)"]),
    ttftP50Ms: pick("50%"),
    ttftP99Ms: pick("99%"),
    tpotMs: num(summary["Avg TPOT (ms)"]),
    itlMs: num(summary["Avg ITL (ms)"]),
    outputTps: num(summary["Output Throughput (tok/s)"]),
    totalTps: num(summary["Total Throughput (tok/s)"]),
    inputTokens: num(summary["Avg Input Tokens"]),
    outputTokens: num(summary["Avg Output Tokens"]),
  };
}

function parsePerfModelDir(runDir, modelDirName) {
  const modelPath = path.join(runDir, modelDirName);
  if (!fs.existsSync(path.join(modelPath, "performance_summary.txt"))) {
    // A model dir without the perf summary is not a perf report.
    const hasLevels = listDir(modelPath).some((e) => e.isDirectory() && /^parallel_/.test(e.name));
    if (!hasLevels) return null;
  }
  const levels = listDir(modelPath)
    .filter((e) => e.isDirectory() && /^parallel_\d+_number_\d+$/.test(e.name))
    .map((e) => parsePerfLevel(path.join(modelPath, e.name)))
    .filter(Boolean)
    .sort((a, b) => (a.concurrency ?? 0) - (b.concurrency ?? 0));
  if (!levels.length) return null;
  return { model: modelDirName, perfLevels: levels, datasetScores: [], overallScore: null };
}

// ─── eval ─────────────────────────────────────────────────
function parseEvalReportFile(filePath) {
  const data = readJson(filePath);
  if (!data || typeof data !== "object") return null;
  if (data.schema_version == null && !Array.isArray(data.metrics)) return null;

  const metric = Array.isArray(data.metrics) ? data.metrics[0] : null;
  const score = metric ? num(metric.score) ?? num(metric.macro_score) : null;
  const metricName =
    metric?.identity?.name || metric?.semantics?.metric_name || metric?.legacy_name || null;
  const datasetName = data.dataset_name || path.basename(filePath, ".json");

  const subsets = [];
  if (metric && Array.isArray(metric.categories)) {
    for (const cat of metric.categories) {
      const catName = Array.isArray(cat?.name) ? cat.name.join("/") : cat?.name;
      for (const sub of Array.isArray(cat?.subsets) ? cat.subsets : []) {
        if (sub?.is_aggregate) continue;
        subsets.push({
          name: catName && catName !== "default" ? `${catName}/${sub?.name ?? "—"}` : sub?.name ?? "—",
          metric: metricName,
          score: num(sub?.score),
          num: num(sub?.num),
        });
      }
    }
  }

  return {
    datasetName: data.dataset_pretty_name || datasetName,
    datasetId: datasetName,
    metric: metricName,
    score,
    num: num(metric?.num) ?? num(data.num),
    model: data.model_name || null,
    subsets,
    raw: {
      schema_version: data.schema_version ?? null,
      name: data.name ?? null,
      model_name: data.model_name ?? null,
      dataset_name: datasetName,
      metrics: metric
        ? {
            name: metricName,
            num: num(metric.num),
            score: num(metric.score),
            macro_score: num(metric.macro_score),
          }
        : null,
      execution_summary: data.execution_summary ?? null,
      perf_summary: data.perf_metrics?.summary ?? null,
    },
  };
}

function parseEvalRunDir(runDir, modelDirName) {
  const modelPath = path.join(runDir, modelDirName);
  const datasetFiles = listDir(modelPath).filter(
    (e) => e.isFile() && e.name.endsWith(".json")
  );
  const datasetScores = [];
  const subsets = [];
  let model = modelDirName;
  let raw = null;

  for (const file of datasetFiles) {
    const parsed = parseEvalReportFile(path.join(modelPath, file.name));
    if (!parsed) continue;
    if (parsed.model) model = parsed.model;
    raw = raw || parsed.raw;
    datasetScores.push({
      name: parsed.datasetName,
      metric: parsed.metric,
      score: parsed.score,
      num: parsed.num,
      datasetId: parsed.datasetId,
    });
    subsets.push(...parsed.subsets);
  }
  if (!datasetScores.length) return null;

  const scored = datasetScores.filter((d) => d.score != null);
  const overallScore = scored.length
    ? scored.reduce((sum, d) => sum + d.score, 0) / scored.length
    : null;

  return { model, datasetScores, subsets, overallScore, raw };
}

// ─── scan ─────────────────────────────────────────────────
function scanReports(outputsDir) {
  /** @type {object[]} */
  const reports = [];
  const runDirs = listDir(outputsDir)
    .filter((e) => e.isDirectory() && parseTimestamp(e.name) != null)
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, MAX_SCAN_DIRS);

  for (const run of runDirs) {
    const runDir = path.join(outputsDir, run.name);
    const createdAt = parseTimestamp(run.name);
    const modelDirs = listDir(runDir).filter((e) => e.isDirectory());

    const eReports = modelDirs.filter((e) => e.name === "reports");
    if (eReports.length) {
      for (const modelDir of listDir(path.join(runDir, "reports"))) {
        if (!modelDir.isDirectory()) continue;
        if (modelDir.name.startsWith(".")) continue;
        const parsed = parseEvalRunDir(path.join(runDir, "reports"), modelDir.name);
        if (!parsed) continue;
        reports.push({
          reportId: `${run.name}/${modelDir.name}`,
          kind: "eval",
          model: parsed.model,
          modelId: null,
          createdAt,
          dir: `${run.name}/reports/${modelDir.name}`,
          jobId: null,
          datasetScores: parsed.datasetScores,
          overallScore: parsed.overallScore,
          perfLevels: [],
          subsets: parsed.subsets,
          raw: parsed.raw,
        });
      }
    }

    for (const modelDir of modelDirs) {
      if (["reports", "reviews", "predictions", "configs", "logs"].includes(modelDir.name)) continue;
      if (modelDir.name.startsWith(".")) continue;
      const parsed = parsePerfModelDir(runDir, modelDir.name);
      if (!parsed) continue;
      reports.push({
        reportId: `${run.name}/${modelDir.name}`,
        kind: "perf",
        model: parsed.model,
        modelId: null,
        createdAt,
        dir: `${run.name}/${modelDir.name}`,
        jobId: null,
        datasetScores: [],
        overallScore: null,
        perfLevels: parsed.perfLevels,
        subsets: [],
        raw: null,
      });
    }
  }
  return reports;
}

function cachedReports() {
  const key = EVALESCOPE_OUTPUTS_DIR;
  if (_cache && _cache.key === key && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.reports;
  }
  const reports = fs.existsSync(EVALESCOPE_OUTPUTS_DIR) ? scanReports(EVALESCOPE_OUTPUTS_DIR) : [];
  _cache = { at: Date.now(), key, reports };
  return reports;
}

/** @returns {object[]} summaries (without heavy `subsets`/`raw` fields) */
export function listReports() {
  return cachedReports().map(({ subsets, raw, ...summary }) => summary);
}

/**
 * @param {string} reportId e.g. "20260924_111457/qwen3.8-flash-next"
 * @returns {object | null}
 */
export function getReport(reportId) {
  const wanted = String(reportId || "").replace(/^\/+|\/+$/g, "");
  return cachedReports().find((r) => r.reportId === wanted) || null;
}

/**
 * Attach job ids to reports by report dir (preferred) or model + time window.
 * @param {object[]} reports
 * @param {object[]} jobs
 */
export function attachJobIds(reports, jobs) {
  const jobList = Array.isArray(jobs) ? jobs : [];
  const pending = (Array.isArray(reports) ? reports : []).filter((r) => r && !r.jobId);

  // Pass 1: exact report-directory match always wins, regardless of job order.
  for (const report of pending) {
    const match = jobList.find((job) => {
      if (job.kind !== report.kind || !job.reportDir) return false;
      const rel = path.relative(EVALESCOPE_OUTPUTS_DIR, job.reportDir);
      return (
        report.dir === rel ||
        report.dir.startsWith(rel + "/") ||
        rel.startsWith(report.dir + "/")
      );
    });
    if (match) report.jobId = match.jobId;
  }

  // Pass 2: fall back to model + time proximity for jobs that never reported a
  // directory (e.g. older runs), preferring completed jobs closest to the run.
  for (const report of pending) {
    if (report.jobId) continue;
    const ts = report.createdAt;
    if (ts == null) continue;
    const model = String(report.model || "").toLowerCase();
    const candidates = jobList
      .filter((job) => {
        if (job.kind !== report.kind) return false;
        if (job.status && job.status !== "completed") return false;
        const label = String(job.modelLabel || "").toLowerCase();
        const sameModel = !label || !model || model.includes(label.split(" ")[0]) || label.includes(model);
        if (!sameModel || !job.startedAt) return false;
        return ts >= job.startedAt - 120_000 && ts <= (job.completedAt || Date.now()) + 900_000;
      })
      .sort((a, b) => Math.abs(ts - a.startedAt) - Math.abs(ts - b.startedAt));
    if (candidates[0]) report.jobId = candidates[0].jobId;
  }

  return reports;
}

export { EVALESCOPE_OUTPUTS_DIR };
