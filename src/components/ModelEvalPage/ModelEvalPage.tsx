/**
 * Model eval page — one place to benchmark (speed) and evaluate (accuracy)
 * the models configured in this dashboard, backed by the EvalScope engine.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchEvalModels, fetchEvalService } from "../../api/client";
import type { EvalModel, EvalServiceStatus } from "../../api/types";
import { RotateIcon, ExternalLinkIcon } from "../ui/icons";
import { ModelsPanel } from "./ModelsPanel";
import { SpeedPanel } from "./SpeedPanel";
import { EvalPanel } from "./EvalPanel";
import { SvgPanel } from "./SvgPanel";
import { GeminiTaskPanel } from "./GeminiTaskPanel";

type Tab = "models" | "speed" | "intelligence" | "svg" | "gemini";

const TABS: { id: Tab; label: string }[] = [
  { id: "models", label: "模型" },
  { id: "speed", label: "速度" },
  { id: "intelligence", label: "智力" },
  { id: "svg", label: "SVG / 鹈鹕" },
  { id: "gemini", label: "Gemini Task" },
];

export function ModelEvalPage() {
  const [tab, setTab] = useState<Tab>("models");
  const [models, setModels] = useState<EvalModel[] | null>(null);
  const [service, setService] = useState<EvalServiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [modelsRes, serviceRes] = await Promise.all([
        fetchEvalModels(),
        fetchEvalService().catch(() => null),
      ]);
      setModels(modelsRes.models || []);
      setService(serviceRes);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      fetchEvalService()
        .then(setService)
        .catch(() => setService(null));
    }, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const serviceUrl = service?.url || "http://127.0.0.1:9000";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="panel-title">模型评测</h2>
        <span className="chip">{tab === "svg" ? "本地 SVG 工作台" : tab === "gemini" ? "浏览器任务（Work 模式）" : "EvalScope 引擎"}</span>
        {tab !== "svg" && tab !== "gemini" && <>
        <span
          className={`text-xs ${service?.up ? "text-success" : "text-warning"}`}
          title={service?.error || undefined}
        >
          {service?.up
            ? `服务在线 ${service.latencyMs != null ? `${service.latencyMs}ms` : ""}`
            : service?.error
              ? `服务不可用：${service.error}`
              : "服务状态未知"}
        </span>
        <a
          className="flex items-center gap-1 text-xs text-muted hover:text-accent"
          href={serviceUrl}
          target="_blank"
          rel="noreferrer"
        >
          打开 EvalScope <ExternalLinkIcon className="h-3.5 w-3.5" />
        </a>
        </>}
        <button
          type="button"
          className="icon-circle ml-auto"
          title="刷新模型列表"
          onClick={() => void refresh()}
        >
          <RotateIcon className="h-3.5 w-3.5" />
        </button>
      </header>

      <nav className="pill-nav" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`pill-item${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="pill-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {error && <div className="bench-sheet__error">{error}</div>}

      {models == null ? (
        <p className="bench-sheet__hint">加载中…</p>
      ) : tab === "models" ? (
        <ModelsPanel models={models} onChanged={() => void refresh()} />
      ) : tab === "speed" ? (
        <SpeedPanel models={models} serviceUrl={serviceUrl} />
       ) : tab === "svg" ? (
         <SvgPanel models={models} />
       ) : tab === "gemini" ? (
         <GeminiTaskPanel />
       ) : (
        <EvalPanel models={models} serviceUrl={serviceUrl} />
      )}
    </div>
  );
}
