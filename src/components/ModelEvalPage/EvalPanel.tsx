/**
 * Accuracy tab — launches `evalscope eval` (OpenAI-compatible API) and shows
 * the parsed scores, per-dataset detail and a 2–3 model comparison table.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelEvalJob,
  fetchEvalJobs,
  fetchEvalReport,
  fetchEvalReports,
  getEvalJob,
  startEvalJob,
} from "../../api/client";
import type {
  EvalModel,
  EvalReportDetail,
  EvalReportSummary,
  EvalScopeJob,
} from "../../api/types";
import { ExternalLinkIcon } from "../ui/icons";
import { JobLog, formatDuration, statusClass, statusLabel } from "./JobLog";

const inputCls = "bench-input w-full";

function scoreText(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return "—";
  return `${(score * 100).toFixed(1)}%`;
}

export function EvalPanel({
  models,
  serviceUrl,
}: {
  models: EvalModel[];
  serviceUrl: string;
}) {
  const enabled = useMemo(() => models.filter((m) => m.enabled), [models]);
  const [modelId, setModelId] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [datasets, setDatasets] = useState<string[]>(["gsm8k"]);
  const [customDataset, setCustomDataset] = useState("");
  const [limit, setLimit] = useState("50");
  const [active, setActive] = useState<EvalScopeJob | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<EvalScopeJob[]>([]);
  const [reports, setReports] = useState<EvalReportSummary[]>([]);
  const [detail, setDetail] = useState<EvalReportDetail | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
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
      setJobs(jobsRes.jobs.filter((j) => j.kind === "eval"));
      setSuggestions(jobsRes.defaults.datasetSuggestions);
      setReports(reportsRes.reports.filter((r) => r.kind === "eval"));
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
            timerRef.current = window.setTimeout(tick, 2500);
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
      if (res?.active && res.active.kind === "eval") {
        setActive(res.active);
        poll(res.active.jobId);
      }
    })();
    return stopPoll;
  }, [poll, refreshLists, stopPoll]);

  const toggleDataset = (name: string) => {
    setDatasets((prev) =>
      prev.includes(name) ? prev.filter((d) => d !== name) : [...prev, name]
    );
  };

  const addCustom = () => {
    const name = customDataset.trim();
    if (!name) return;
    if (!datasets.includes(name)) setDatasets((prev) => [...prev, name]);
    setCustomDataset("");
  };

  const handleStart = async () => {
    if (!modelId) {
      setError("先选择一个模型");
      return;
    }
    if (datasets.length === 0) {
      setError("至少选一个数据集");
      return;
    }
    setStarting(true);
    setError(null);
    setLogs([]);
    try {
      const job = await startEvalJob({
        kind: "eval",
        modelId,
        datasets,
        limit: parseInt(limit, 10) || undefined,
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

  const openDetail = async (reportId: string) => {
    setError(null);
    try {
      setDetail(await fetchEvalReport(reportId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleCompare = (reportId: string) => {
    setCompare((prev) => {
      if (prev.includes(reportId)) return prev.filter((r) => r !== reportId);
      if (prev.length >= 3) return prev;
      return [...prev, reportId];
    });
  };

  const finished = jobs.filter((j) => j.status !== "running");
  const compareReports = reports.filter((r) => compare.includes(r.reportId));
  const compareDatasets = useMemo(() => {
    const names = new Set<string>();
    for (const r of compareReports) for (const d of r.datasetScores) names.add(d.name);
    return [...names];
  }, [compareReports]);

  return (
    <div className="flex flex-col gap-4">
      <section className="panel p-4">
        <h3 className="panel-title">能力评测（evalscope eval · openai_api）</h3>
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
              <span className="bench-sheet__section-title">每数据集样本数上限</span>
              <p className="bench-sheet__hint">留空跑全量；冒烟建议 20–50</p>
            </div>
            <input
              className={inputCls}
              inputMode="numeric"
              value={limit}
              onChange={(e) => /^\d*$/.test(e.target.value) && setLimit(e.target.value)}
              disabled={!!active}
            />
          </label>
          <div className="bench-field sm:col-span-2">
            <div className="bench-field__head">
              <span className="bench-sheet__section-title">数据集</span>
              <p className="bench-sheet__hint">来自 EvalScope 的基准库；首次运行会从 ModelScope 下载</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[...new Set([...suggestions, ...datasets])].map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`chip${datasets.includes(name) ? " is-active" : ""}`}
                  style={
                    datasets.includes(name)
                      ? { borderColor: "var(--accent)", color: "var(--accent)" }
                      : undefined
                  }
                  disabled={!!active}
                  onClick={() => toggleDataset(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                className={inputCls}
                placeholder="添加其它数据集名（如 mmlu_pro / ifeval / ceval）"
                value={customDataset}
                onChange={(e) => setCustomDataset(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                disabled={!!active}
              />
              <button type="button" className="pill-item" onClick={addCustom} disabled={!!active}>
                添加
              </button>
            </div>
          </div>
        </div>

        {error && <p className="bench-sheet__error mt-2">{error}</p>}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="bench-conc-btn is-on"
            onClick={handleStart}
            disabled={!!active || starting || !modelId}
          >
            {starting ? "启动中…" : "开始评测"}
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
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="panel-title">评测报告</h3>
          <span className="text-xs text-muted">勾选 2–3 份做对比</span>
          {compare.length > 0 && (
            <button type="button" className="pill-item ml-auto" onClick={() => setCompare([])}>
              清除对比
            </button>
          )}
        </div>

        {compareReports.length >= 2 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted">
                  <th className="p-1 text-left">数据集</th>
                  {compareReports.map((r) => (
                    <th key={r.reportId} className="p-1 text-right">
                      {r.model}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareDatasets.map((name) => (
                  <tr key={name} className="border-t border-border">
                    <td className="p-1 text-text-strong">{name}</td>
                    {compareReports.map((r) => {
                      const row = r.datasetScores.find((d) => d.name === name);
                      return (
                        <td key={r.reportId} className="p-1 text-right">
                          {scoreText(row?.score ?? null)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td className="p-1 font-semibold text-text-strong">平均</td>
                  {compareReports.map((r) => (
                    <td key={r.reportId} className="p-1 text-right font-semibold">
                      {scoreText(r.overallScore)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {reports.length === 0 ? (
          <p className="bench-sheet__hint mt-2">还没有评测报告。</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {reports.map((r) => (
              <article key={r.reportId} className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs">
                <input
                  type="checkbox"
                  checked={compare.includes(r.reportId)}
                  onChange={() => toggleCompare(r.reportId)}
                  title="加入对比"
                />
                <span className="font-semibold text-text-strong">{r.model}</span>
                <span className="text-muted">
                  {r.datasetScores.length} 个数据集 · 平均 {scoreText(r.overallScore)}
                </span>
                <span className="text-muted">
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : r.dir}
                </span>
                <button
                  type="button"
                  className="pill-item ml-auto"
                  onClick={() => openDetail(r.reportId)}
                >
                  查看
                </button>
              </article>
            ))}
          </div>
        )}

        {detail && (
          <div className="mt-3 rounded border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-strong">{detail.model}</span>
              <button type="button" className="pill-item ml-auto" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-muted">
                  <th className="p-1 text-left">数据集 / 子集</th>
                  <th className="p-1 text-left">指标</th>
                  <th className="p-1 text-right">分数</th>
                  <th className="p-1 text-right">样本</th>
                </tr>
              </thead>
              <tbody>
                {(detail.subsets.length ? detail.subsets : detail.datasetScores).map((row) => (
                  <tr key={row.name} className="border-t border-border">
                    <td className="p-1 text-text-strong">{row.name}</td>
                    <td className="p-1 text-muted">{row.metric || "—"}</td>
                    <td className="p-1 text-right">{scoreText(row.score)}</td>
                    <td className="p-1 text-right">{row.num ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel p-4">
        <h3 className="panel-title">运行历史</h3>
        {finished.length === 0 ? (
          <p className="bench-sheet__hint mt-2">还没有评测记录。</p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5 text-xs">
            {finished.map((job) => (
              <div key={job.jobId} className="flex flex-wrap items-center gap-2">
                <span className={`font-semibold ${statusClass(job.status)}`}>
                  {statusLabel(job.status)}
                </span>
                <span className="text-text-strong">{job.modelLabel}</span>
                <span className="text-muted">
                  {job.params.datasets.join(", ")} · {new Date(job.startedAt).toLocaleString()} ·{" "}
                  {formatDuration(job.durationMs)}
                </span>
                {job.error && <span className="text-warning">{job.error}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
