import { useEffect, useState } from "react";
import { cancelSvgJob, fetchSvgJob, fetchSvgJobs, fetchSvgPair, startSvgJob, voteSvgPair } from "../../api/client";
import type { EvalModel, SvgJob, SvgJobsResponse, SvgPair, SvgSample } from "../../api/types";
import { formatDuration } from "./JobLog";
import "./SvgPanel.css";

const statuses: Record<string, string> = { pending: "等待", running: "生成中", cancelling: "取消中", completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "被中断", completed_with_errors: "完成（含失败样本）" };
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const imageUrl = (s: SvgSample) => `/api/svg/assets/${s.id}.png`;

export function SvgPanel({ models }: { models: EvalModel[] }) {
  const [list, setList] = useState<SvgJobsResponse | null>(null);
  const [selected, setSelected] = useState("");
  const [job, setJob] = useState<SvgJob | null>(null);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [agySelected, setAgySelected] = useState(false);
  const [agyModel, setAgyModel] = useState('gemini-3.8-flash-high');
  const [agy, setAgy] = useState<{ installed: boolean; version: string | null; modelsText: string; error?: string } | null>(null);
  const [prompt, setPrompt] = useState("Generate an SVG of a pelican riding a bicycle");
  const [repetitions, setRepetitions] = useState(3);
  const [maxTokens, setMaxTokens] = useState(8192);
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [extra, setExtra] = useState("{}");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"gallery" | "blind">("gallery");
  const [pair, setPair] = useState<SvgPair | null>(null);
  const [reveal, setReveal] = useState<{ a: string; b: string } | null>(null);
  const [detail, setDetail] = useState<SvgSample | null>(null);

  useEffect(() => {
    let disposed = false;
    void fetch('/api/svg/antigravity').then(async res => {
      if (!res.ok) throw new Error('Could not inspect Antigravity CLI');
      const info = await res.json();
      if (!disposed) setAgy(info);
    }).catch(() => { if (!disposed) setAgy(null); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await fetchSvgJobs();
        const id = selected || result.activeId || result.jobs[0]?.id || "";
        const current = id ? await fetchSvgJob(id) : null;
        if (!disposed) { setList(result); setJob(current); }
      } catch (e) { if (!disposed) setError((e as Error).message); }
      if (!disposed) timer = window.setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [selected]);
  useEffect(() => { setPair(null); setReveal(null); }, [selected]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setDetail(null); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const nextPair = () => void action(async () => {
    if (!job) return;
    setPair(await fetchSvgPair(selected || job.id)); setReveal(null);
  });
  const running = !!list?.activeId;
  const selectedModelIds = [...modelIds, ...(agySelected ? [`agy/${agyModel.trim()}`] : [])];
  const completed = job?.samples.filter(s => s.status === "completed").length || 0;
  const votes = job?.votes || [];
  const stats = [...new Set(job?.samples.map(s => s.modelId) || [])].map(id => {
    const samples = job!.samples.filter(s => s.modelId === id);
    let wins = 0, ties = 0, total = 0;
    for (const vote of votes) {
      const side = samples.some(s => s.id === vote.a) ? "a" : samples.some(s => s.id === vote.b) ? "b" : null;
      if (side) { total++; if (vote.winner === side) wins++; if (vote.winner === "tie") ties++; }
    }
    return { label: samples[0].modelLabel, valid: samples.filter(s => s.status === "completed").length, count: samples.length, wins, ties, total };
  });

  return <div className="svg-workbench flex flex-col gap-4">
    <section className="panel p-4 flex flex-col gap-3">
      <h3 className="panel-title">SVG / 鹈鹕工作台</h3>
      <p className="text-sm text-muted">新对话、单轮生成、逐样本保留原始输出。PNG 隔离渲染；人工盲评观察动物特征、骑行姿态、车架和轮子的关系，不能代表模型的整体能力。</p>
      <div className="flex flex-wrap gap-3">
        {models.filter(m => m.enabled).map(m => <label key={m.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={modelIds.includes(m.id)} disabled={running || busy} onChange={e => setModelIds(ids => e.target.checked ? [...ids, m.id] : ids.filter(id => id !== m.id))} />{m.label}
        </label>)}
        {!models.some(m => m.enabled) && <p className="text-warning">请先在「模型」页添加并启用模型。</p>}
      </div>
      {agy?.installed && <div className="flex flex-col gap-2">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={agySelected} disabled={running || busy} onChange={e => setAgySelected(e.target.checked)} />Antigravity 官方 CLI · {agy.version}
          <input aria-label="Antigravity 模型 slug" className="bench-input" value={agyModel} disabled={running || busy} onChange={e => setAgyModel(e.target.value)} placeholder="agy models 中的模型 slug" />
        </label>
        <details><summary className="text-xs cursor-pointer">Antigravity 模型列表 / 测试说明</summary>
          <p className="text-xs text-muted my-2">使用已登录的 Google 订阅。每样本新对话、原题不变；CLI 自带智能体上下文，属于客户端测试。输出 token 上限对 CLI 不生效，温度/top_p 请留空，额外 JSON 用 {}。仅渲染最终回答中的 SVG，不读取生成文件，也不自动重试。</p>
          <pre className="text-xs whitespace-pre-wrap">{agy.modelsText || agy.error || '在本机运行 agy models 查看模型列表；首次运行 agy 完成登录。'}</pre>
        </details>
      </div>}
      <label className="text-sm">题目预设<select aria-label="题目预设" className="bench-input ml-2" defaultValue="pelican" onChange={e => {
        const preset = list?.presets.find(p => p.id === e.target.value); if (preset) setPrompt(preset.prompt);
      }}><option value="custom">自定义（编辑下方提示词）</option>{(list?.presets || [{ id: "pelican", label: "鹈鹕骑自行车（原题）", prompt }]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <textarea aria-label="SVG 提示词" className="bench-input w-full" rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <label className="text-xs">每模型次数<input aria-label="每模型次数" className="bench-input w-full" type="number" min={1} max={10} value={repetitions} onChange={e => setRepetitions(Number(e.target.value))} /></label>
        <label className="text-xs">输出 token 上限<input aria-label="输出 token 上限" className="bench-input w-full" type="number" min={128} max={65536} value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} /></label>
        <label className="text-xs">温度（空=模型默认）<input aria-label="温度" className="bench-input w-full" type="number" min={0} max={2} step={0.1} value={temperature} onChange={e => setTemperature(e.target.value)} /></label>
        <label className="text-xs">top_p（空=模型默认）<input aria-label="top_p" className="bench-input w-full" type="number" min={0.01} max={1} step={0.05} value={topP} onChange={e => setTopP(e.target.value)} /></label>
        <label className="text-xs">单样本超时（秒）<input aria-label="单样本超时" className="bench-input w-full" type="number" min={10} max={1800} value={timeoutSeconds} onChange={e => setTimeoutSeconds(Number(e.target.value))} /></label>
      </div>
      <details><summary className="text-sm cursor-pointer">高级参数 / 思考模式与量化记录</summary>
        <p className="text-xs text-muted my-2">额外请求 JSON，例如 chat_template_kwargs 或 reasoning。按后端要求填写；所有实际参数会被保存，默认不强制思考开关。</p>
        <textarea aria-label="额外请求 JSON" className="bench-input w-full font-mono" rows={3} value={extra} onChange={e => setExtra(e.target.value)} />
        <input aria-label="评测备注" className="bench-input w-full mt-2" placeholder="量化、模型版本、思考配置等备注" value={notes} onChange={e => setNotes(e.target.value)} />
      </details>
      <div className="flex flex-wrap gap-3 items-center"><button className="bench-conc-btn is-on" disabled={busy || running || !selectedModelIds.length || !prompt.trim() || (agySelected && !agyModel.trim())} onClick={() => void action(async () => {
        const next = await startSvgJob({ modelIds: selectedModelIds, prompt, repetitions, maxTokens, timeoutSeconds, temperature: temperature === "" ? null : Number(temperature), topP: topP === "" ? null : Number(topP), extraBody: JSON.parse(extra), notes });
        setSelected(next.id); setJob(next); setMode("gallery"); setList(prev => prev ? { ...prev, activeId: next.id } : prev);
      })}>{busy ? "处理中…" : `开始生成 ${selectedModelIds.length * repetitions} 个样本`}</button>
        <span className="text-xs text-muted">串行执行，避免并发抢占推理资源</span>
        {running && <button className="pill-item" disabled={busy} onClick={() => void action(async () => { await cancelSvgJob(list!.activeId!); })}>取消当前任务</button>}
      </div>
    </section>
    {error && <p role="alert" className="bench-sheet__error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="评测历史" className="bench-input max-w-full" value={selected || job?.id || ""} onChange={e => setSelected(e.target.value)}>
        {!list?.jobs.length && <option value="">尚无结果</option>}
        {list?.jobs.map(j => <option key={j.id} value={j.id}>{new Date(j.startedAt).toLocaleString()} · {statuses[j.status]} · {j.samples.length} 样本</option>)}
      </select>
      <button className={`pill-item${mode === "gallery" ? " is-active" : ""}`} onClick={() => setMode("gallery")}>画廊</button>
      <button className={`pill-item${mode === "blind" ? " is-active" : ""}`} onClick={() => { setMode("blind"); if (!pair) nextPair(); }}>盲评</button>
      {job && <a className="text-sm text-accent ml-auto" href={`/api/svg/jobs/${job.id}/export`} download>导出完整 JSON</a>}
    </div>
    {job && <section className="panel p-4 flex flex-col gap-2">
      <p className="text-sm">{statuses[job.status]} · 成功渲染 {completed}/{job.samples.length} · {job.samples.filter(s => !["pending", "running"].includes(s.status)).length} 个已处理 · {votes.length} 次人工投票</p>
      <p className="text-xs text-muted break-words">{job.prompt}</p>
      <details><summary className="text-xs cursor-pointer">本次实际配置</summary><pre className="text-xs whitespace-pre-wrap mt-2">{JSON.stringify(job.params, null, 2)}</pre></details>
      {job.samples.filter(s => s.status === "running").map(s => <p key={s.id} className="text-xs text-accent">{s.modelLabel} #{s.repetition} · 正文 {s.answerChars || 0} 字符 / 思考 {s.reasoningChars || 0} 字符</p>)}
    </section>}
    {mode === "gallery" ? <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {job?.samples.map(s => <article key={s.id} className="panel p-3 flex flex-col gap-2">
        <div className="flex justify-between gap-2 text-sm"><strong>{s.modelLabel} #{s.repetition}</strong><span className={s.status === "failed" ? "text-warning" : "text-muted"}>{statuses[s.status]}</span></div>
        {s.status === "completed" ? <button aria-label={`查看 ${s.modelLabel} 样本 ${s.repetition}`} onClick={() => setDetail(s)}><img src={imageUrl(s)} alt={`${s.modelLabel} SVG 样本 ${s.repetition}`} className="w-full h-64 object-contain rounded bg-white" /></button> : <div className="h-32 flex items-center justify-center text-xs text-muted">{s.error || statuses[s.status]}</div>}
        <p className="text-xs text-muted">{s.durationMs != null ? formatDuration(s.durationMs) : "—"} · TTFT {s.ttftMs != null ? `${s.ttftMs}ms` : "—"} · {s.finishReason || "—"}</p>
        {(s.truncated || ["length", "max_output_tokens"].includes(s.finishReason || "")) && <p className="text-xs text-warning">已达输出上限，请勿当成正常完整输出。</p>}
        {s.warnings?.map(w => <p key={w} className="text-xs text-warning">{w}</p>)}
        <button className="pill-item text-xs" onClick={() => setDetail(s)}>原始输出 / 源码 / 下载</button>
      </article>)}
    </div> : <section className="panel p-4 flex flex-col gap-4">
      <p className="text-sm text-muted">模型名在投票后揭晓。仅同一题目内跨模型随机配对；投票是个人偏好记录，不是标准榜单。</p>
      {pair && <><p className="text-sm">{pair.prompt}</p><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{(["a", "b"] as const).map(side => <div key={side}><h4 className="text-center mb-2">{side.toUpperCase()}{reveal && ` · ${reveal[side]}`}</h4><img src={pair[side]} alt={`盲评 ${side.toUpperCase()}`} className="w-full h-96 object-contain bg-white rounded" /></div>)}</div>
        <div className="flex justify-center gap-3">{(["a", "tie", "b"] as const).map(winner => <button key={winner} disabled={busy || !!reveal} className="bench-conc-btn is-on" onClick={() => void action(async () => { setReveal(await voteSvgPair(pair.token, winner)); })}>{winner === "tie" ? "平局" : `${winner.toUpperCase()} 更好`}</button>)}</div></>}
      <button disabled={busy || !job} className="pill-item" onClick={nextPair}>{pair ? "下一组" : "开始盲评"}</button>
      {reveal && <p className="text-xs text-muted text-center">投票已保存；选择下一组继续。</p>}
    </section>}
    {job && mode === "gallery" && <section className="panel p-4 overflow-auto"><h3 className="text-sm mb-2">本次统计</h3><table className="w-full text-sm"><thead><tr className="text-left text-muted"><th>模型</th><th>渲染成功</th><th>盲评胜 / 平 / 参与</th></tr></thead><tbody>{stats.map((s, i) => <tr key={i}><td>{s.label}</td><td>{s.valid}/{s.count}</td><td>{s.wins} / {s.ties} / {s.total}</td></tr>)}</tbody></table></section>}
    {detail && <div role="dialog" aria-modal="true" aria-label="SVG 样本详情" className="fixed inset-0 z-50 bg-black/80 p-4 overflow-auto" onClick={() => setDetail(null)}><div className="panel max-w-5xl mx-auto p-4 flex flex-col gap-3" onClick={e => e.stopPropagation()}>
      <div className="flex justify-between"><h3>{detail.modelLabel} #{detail.repetition}</h3><button className="pill-item" autoFocus onClick={() => setDetail(null)}>关闭（Esc）</button></div>
      {detail.status === "completed" && <img src={imageUrl(detail)} alt="放大预览" className="w-full max-h-[70vh] object-contain bg-white" />}
      <div className="flex gap-3 flex-wrap">{detail.svg && <button className="pill-item" onClick={() => download(detail.svg!, `${detail.id}.svg`)}>下载 SVG</button>}<button className="pill-item" onClick={() => download(JSON.stringify(detail, null, 2), `${detail.id}.json`)}>下载原始记录</button>{detail.status === "completed" && <a className="pill-item" download={`${detail.id}.png`} href={imageUrl(detail)}>下载 PNG</a>}</div>
      <p className="text-xs text-muted break-words">{detail.model} · {detail.apiType} · {detail.baseUrl}</p>
      {detail.error && <p className="text-warning">{detail.error}</p>}
      {detail.execution && <details><summary className="text-sm cursor-pointer">客户端实际执行配置</summary><pre className="text-xs whitespace-pre-wrap break-words">{JSON.stringify(detail.execution, null, 2)}</pre></details>}
      {([['SVG 源码', detail.svg], ['正文原始输出', detail.answer], ['思考输出', detail.reasoning], ['usage / 结束原因', JSON.stringify({ usage: detail.usage, finishReason: detail.finishReason }, null, 2)]]).map(([label, text]) => <details key={label}><summary className="text-sm cursor-pointer">{label}</summary><pre className="text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto mt-2">{text || "无"}</pre></details>)}
    </div></div>}
  </div>;
}
