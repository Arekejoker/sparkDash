/**
 * Speed tab — launches `evalscope perf` against a registered model and shows
 * the parsed throughput / latency report (TTFT, TPOT, tok/s, success rate).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelEvalJob,
  fetchEvalJobs,
  fetchEvalReports,
  getEvalJob,
  startEvalJob,
} from "../../api/client";
import type { EvalModel, EvalReportSummary, EvalScopeJob } from "../../api/types";
import { ExternalLinkIcon } from "../ui/icons";
import { JobLog, formatDuration, statusClass, statusLabel } from "./JobLog";

function fmt(n: number | null | undefined, digits = 1, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function PerfTable({ report }: { report: EvalReportSummary }) {
  if (!report.perfLevels.length) {
    return <p className="bench-sheet__hint">报告里没有解析到性能指标。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted">
            <th className="p-1 text-left">档位</th>
            <th className="p-1 text-right">成功</th>
            <th className="p-1 text-right">RPS</th>
            <th className="p-1 text-right">TTFT avg</th>
            <th className="p-1 text-right">TTFT p50</th>
            <th className="p-1 text-right">TTFT p99</th>
            <th className="p-1 text-right">TPOT</th>
            <th className="p-1 text-right">延迟 avg</th>
            <th className="p-1 text-right">输出 tok/s</th>
            <th className="p-1 text-right">总 tok/s</th>
          </tr>
        </thead>
        <tbody>
          {report.perfLevels.map((p) => (
            <tr key={p.level} className="border-t border-border">
              <td className="p-1 text-text-strong">{p.level}</td>
              <td className={`p-1 text-right ${p.failed ? "text-warning" : ""}`}>
                {p.total != null ? `${p.success ?? 0}/${p.total}` : "—"}
              </td>
              <td className="p-1 text-right">{fmt(p.rps, 2)}</td>
              <td className="p-1 text-right">{fmt(p.ttftAvgMs, 0, "ms")}</td>
              <td className="p-1 text-right">{fmt(p.ttftP50Ms, 0, "ms")}</td>
              <td className="p-1 text-right">{fmt(p.ttftP99Ms, 0, "ms")}</td>
              <td className="p-1 text-right">{fmt(p.tpotMs, 2, "ms")}</td>
              <td className="p-1 text-right">{fmt(p.latencyAvgS, 2, "s")}</td>
              <td className="p-1 text-right">{fmt(p.outputTps, 1)}</td>
              <td className="p-1 text-right">{fmt(p.totalTps, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SpeedPanel({
  models,
  serviceUrl,
}: {
  models: EvalModel[];
  serviceUrl: string;
}) {
  const enabled = useMemo(() => models.filter((m) => m.enabled), [models]);
  const [modelId, setModelId] = useState("");
  const [dataset, setDataset] = useState("openqa");
  const [levels, setLevels] = useState<number[]>([1, 4]);
  const [maxTokens, setMaxTokens] = useState("256");
  const [active, setActive] = useState<EvalScopeJob | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<EvalScopeJob[]>([]);
  const [reports, setReports] = useState<EvalReportSummary[]>([]);
  const [maxParallel, setMaxParallel] = useState<number[]>([1, 4, 8, 16, 32]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!modelId && enabled.length > 0) setModelId(enabled[0].id);
  }, [enabled, modelId]);

  const stopPoll = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      const [jobsRes, reportsRes] = await Promise.all([fetchEvalJobs(), fetchEvalReports()]);
      setJobs(jobsRes.jobs.filter((j) => j.kind === "perf"));
      setMaxParallel(jobsRes.defaults.parallelSuggestions);
      setReports(reportsRes.reports.filter((r) => r.kind === "perf"));
      return jobsRes;
    } catch {
      return null;
    }
  }, []);

  const poll = useCallback(
    (jobId: string) => {
      stopPoll();
      const tick = async () => {
        try {
          const job = await getEvalJob(jobId);
          setActive(job.status === "running" ? job : null);
          setLogs(job.logTail || []);
          if (job.status === "running") {
            timerRef.current = window.setTimeout(tick, 2000);
          } else {
            await refreshLists();
          }
        } catch (err) {
          setError((err as Error).message);
        }
      };
      void tick();
    },
    [refreshLists, stopPoll]
  );

  useEffect(() => {
    void (async () => {
      const res = await refreshLists();
      if (res?.active && res.active.kind === "perf") {
        setActive(res.active);
        poll(res.active.jobId);
      }
    })();
    return stopPoll;
  }, [poll, refreshLists, stopPoll]);

  const toggleLevel = (n: number) => {
    setLevels((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)
    );
  };

  const handleStart = async () => {
    if (!modelId) {
      setError("先选择一个模型");
      return;
    }
    if (levels.length === 0) {
      setError("至少选一个并发档位");
      return;
    }
    setStarting(true);
    setError(null);
    setLogs([]);
    try {
      const job = await startEvalJob({
        kind: "perf",
        modelId,
        dataset,
        parallel: levels,
        maxTokens: parseInt(maxTokens, 10) || undefined,
      });
      setActive(job);
      poll(job.jobId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!active) return;
    try {
      await cancelEvalJob(active.jobId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finished = jobs.filter((j) => j.status !== "running");
  const reportFor = (job: EvalScopeJob) => reports.find((r) => r.jobId === job.jobId) || null;

  return (
    <div className="flex flex-col gap-4">
      <section className="panel p-4">
        <h3 className="panel-title">压测（evalscope perf）</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="bench-field">
            <div className="bench-field__head">
              <span className="bench-sheet__section-title">模型</span>
            </div>
            <select
              className={inputCls}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={!!active}
            >
              {enabled.length === 0 && <option value="">（先在「模型」页添加）</option>}
              {enabled.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.model}
                </option>
              ))}
            </select>
          </label>
          <label className="bench-field">
            <div className="bench-field__head">
              <span className="bench-sheet__section-title">数据集</span>
              <p className="bench-sheet__hint">openqa 免 tokenizer；random 需要模型的 tokenizerPath</p>
            </div>
            <select
              className={inputCls}
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              disabled={!!active}
            >
              <option value="openqa">openqa</option>
              <option value="random">random</option>
            </select>
          </label>
          <div className="bench-field sm:col-span-2">
            <div className="bench-field__head">
              <span className="bench-sheet__section-title">并发档位</span>
              <p className="bench-sheet__hint">请求数默认 = 并发 × 2</p>
            </div>
            <div className="bench-conc-grid">
              {maxParallel.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`bench-conc-btn${levels.includes(n) ? " is-on" : ""}`}
                  disabled={!!active}
                  onClick={() => toggleLevel(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="bench-field">
            <div className="bench-field__head">
              <span className="bench-sheet__section-title">Max tokens</span>
            </div>
            <input
              className={inputCls}
              inputMode="numeric"
              value={maxTokens}
              onChange={(e) => /^\d*$/.test(e.target.value) && setMaxTokens(e.target.value)}
              disabled={!!active}
            />
          </label>
        </div>

        {error && <p className="bench-sheet__error mt-2">{error}</p>}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="bench-conc-btn is-on"
            onClick={handleStart}
            disabled={!!active || starting || !modelId}
          >
            {starting ? "启动中…" : "开始压测"}
          </button>
          {active && (
            <button type="button" className="pill-item" onClick={handleCancel}>
              取消
            </button>
          )}
          <a
            className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-accent"
            href={serviceUrl}
            target="_blank"
            rel="noreferrer"
          >
            打开 EvalScope 详情 <ExternalLinkIcon className="h-3.5 w-3.5" />
          </a>
        </div>
      </section>

      {active && (
        <section className="panel p-4">
          <div className="flex items-center gap-2">
            <h3 className="panel-title">运行中</h3>
            <span className={`text-xs ${statusClass(active.status)}`}>
              {statusLabel(active.status)} · {active.modelLabel} · {formatDuration(active.durationMs)}
            </span>
          </div>
          <div className="mt-2">
            <JobLog lines={logs} running />
          </div>
        </section>
      )}

      <section className="panel p-4">
        <h3 className="panel-title">历史</h3>
        {finished.length === 0 ? (
          <p className="bench-sheet__hint mt-2">还没有压测记录。</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {finished.map((job) => {
              const report = reportFor(job);
              return (
                <article key={job.jobId} className="rounded border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`font-semibold ${statusClass(job.status)}`}>
                      {statusLabel(job.status)}
                    </span>
                    <span className="text-text-strong">{job.modelLabel}</span>
                    <span className="text-muted">
                      {new Date(job.startedAt).toLocaleString()} · {formatDuration(job.durationMs)}
                    </span>
                    {job.error && <span className="text-warning">{job.error}</span>}
                  </div>
                  <div className="mt-2">
                    {report ? (
                      <PerfTable report={report} />
                    ) : (
                      <p className="bench-sheet__hint">
                        {job.status === "completed"
                          ? "未找到解析报告，可打开 EvalScope 详情查看。"
                          : "任务未成功完成。"}
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const inputCls = "bench-input w-full";
