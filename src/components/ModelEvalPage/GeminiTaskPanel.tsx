import { useEffect, useState } from "react";
import { cancelGeminiTask, fetchGeminiDriver, fetchGeminiTask, fetchGeminiTasks, refreshGeminiTask, startGeminiTask } from "../../api/client";
import type { GeminiDriverInfo, GeminiTaskJob, GeminiTasksResponse } from "../../api/types";
import { formatDuration } from "./JobLog";

const statuses: Record<string, string> = {
  submitting: "提交中", running: "运行中", cancelling: "取消中", checking: "检查中", complete: "完成",
  timed_out: "等待超时", failed: "失败", cancelled: "已取消", interrupted: "被中断",
};
const statusTone = (status: string) =>
  status === "complete" ? "text-success" : status === "failed" || status === "timed_out" ? "text-warning" : "text-muted";

export function GeminiTaskPanel() {
  const [list, setList] = useState<GeminiTasksResponse | null>(null);
  const [selected, setSelected] = useState("");
  const [job, setJob] = useState<GeminiTaskJob | null>(null);
  const [prompt, setPrompt] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(900);
  const [driver, setDriver] = useState<GeminiDriverInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    void fetchGeminiDriver().then(info => { if (!disposed) setDriver(info); })
      .catch(() => { if (!disposed) setDriver(null); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await fetchGeminiTasks();
        const id = selected || result.activeId || result.jobs[0]?.id || "";
        const current = id ? await fetchGeminiTask(id) : null;
        if (!disposed) { setList(result); setJob(current); }
      } catch (e) { if (!disposed) setError((e as Error).message); }
      if (!disposed) timer = window.setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [selected]);

  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const running = !!list?.activeId;

  return <div className="svg-workbench flex flex-col gap-4">
    <section className="panel p-4 flex flex-col gap-3">
      <h3 className="panel-title">Gemini Task（Work 模式）</h3>
      <p className="text-sm text-muted">通过共享浏览器驱动真实 Gemini 页面（已登录个人订阅账号），每次提交新对话、串行执行，不读取 cookie。任务在 Google 服务端执行，可离开页面；长时间任务请加大等待上限，超时会保留对话链接供人工查看。</p>
      {driver && <p className={`text-xs ${driver.installed ? "text-muted" : "text-warning"}`}>驱动{driver.installed ? "可用" : "不可用"} · {driver.path}{driver.python ? ` · ${driver.python}` : ""}</p>}
      <textarea aria-label="任务描述" className="bench-input w-full" rows={3} value={prompt} placeholder="描述一个任务，例如：把下面的要点整理成一页周报…" onChange={e => setPrompt(e.target.value)} />
      <div className="flex flex-wrap gap-3 items-center">
        <label className="text-xs">最长等待（秒）<input aria-label="最长等待秒数" className="bench-input w-28 ml-2" type="number" min={60} max={3600} value={timeoutSeconds} onChange={e => setTimeoutSeconds(Number(e.target.value))} /></label>
        <button className="bench-conc-btn is-on" disabled={busy || running || !prompt.trim() || driver?.installed === false} onClick={() => void action(async () => {
          const next = await startGeminiTask({ prompt, timeoutSeconds });
          setSelected(next.id); setJob(next);
          setList(prev => prev ? { ...prev, activeId: next.id } : prev);
          setPrompt("");
        })}>{busy ? "处理中…" : "提交任务"}</button>
        {running && <button className="pill-item" disabled={busy} onClick={() => void action(async () => { await cancelGeminiTask(list!.activeId!); })}>取消当前任务</button>}
        <span className="text-xs text-muted">同时只运行一个任务；任务记录保留在本机</span>
      </div>
    </section>
    {error && <p role="alert" className="bench-sheet__error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="任务历史" className="bench-input max-w-full" value={selected || job?.id || ""} onChange={e => setSelected(e.target.value)}>
        {!list?.jobs.length && <option value="">尚无任务</option>}
        {list?.jobs.map(j => <option key={j.id} value={j.id}>{new Date(j.startedAt).toLocaleString()} · {statuses[j.status] || j.status} · {(j.prompt || "").slice(0, 28)}</option>)}
      </select>
    </div>
    {job && <section className="panel p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <strong className={`text-sm ${statusTone(job.status)}`}>{statuses[job.status] || job.status}</strong>
        {job.model && <span className="chip">{job.model}</span>}
        {job.durationMs != null && <span className="text-xs text-muted">{formatDuration(job.durationMs)}</span>}
        {job.url && <a className="text-xs text-accent" href={job.url} target="_blank" rel="noreferrer">打开 Gemini 对话</a>}
        {job.screenshot && <a className="text-xs text-accent" href={`/api/gemini/jobs/${job.id}/screenshot`} target="_blank" rel="noreferrer">故障截图</a>}
        {job.conversationId && !["complete", "running", "submitting", "cancelling", "checking"].includes(job.status) &&
          <button className="pill-item text-xs" disabled={busy || running} onClick={() => void action(async () => { setJob(await refreshGeminiTask(job.id)); })}>再次检查</button>}
      </div>
      {job.title && <p className="text-sm">{job.title}</p>}
      <p className="text-xs text-muted break-words">提交内容：{job.prompt}</p>
      {job.progress && ["submitting", "running", "cancelling", "checking"].includes(job.status) && <p className="text-xs text-accent">进度：{job.progress.status}{job.progress.steps != null ? ` · 步骤 ${job.progress.steps}` : ""}{job.progress.panels != null ? ` · 输出块 ${job.progress.panels}` : ""}</p>}
      {job.steps.length > 1 && <details><summary className="text-xs cursor-pointer">任务步骤（{job.steps.length}）</summary><ol className="text-xs mt-2 list-decimal ml-4">{job.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></details>}
      {job.error && <p className="text-warning text-sm">{job.error}</p>}
      {job.answer ? <details open><summary className="text-sm cursor-pointer">结果</summary><pre className="text-xs whitespace-pre-wrap break-words max-h-[60vh] overflow-auto mt-2">{job.answer}</pre></details>
        : (job.status === "running" || job.status === "submitting" || job.status === "checking") && <p className="text-xs text-muted">任务运行中，页面每 2 秒刷新一次状态。</p>}
    </section>}
  </div>;
}
