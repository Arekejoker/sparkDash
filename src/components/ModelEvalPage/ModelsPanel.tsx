/**
 * Models tab — registry of external OpenAI-compatible endpoints that
 * EvalScope runs against (speed + accuracy).
 */
import { useState } from "react";
import { deleteEvalModel, probeEvalModel } from "../../api/client";
import type { EvalModel, EvalProbeResult } from "../../api/types";
import { EditIcon, PlusIcon, RotateIcon, BotIcon } from "../ui/icons";
import { EvalModelDialog, ImportModelsDialog } from "./EvalDialogs";

export function ModelsPanel({
  models,
  onChanged,
}: {
  models: EvalModel[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<EvalModel | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [probes, setProbes] = useState<Record<string, EvalProbeResult | "loading" | undefined>>({});
  const [error, setError] = useState<string | null>(null);

  const runProbe = async (id: string) => {
    setProbes((p) => ({ ...p, [id]: "loading" }));
    try {
      const res = await probeEvalModel(id);
      setProbes((p) => ({ ...p, [id]: res }));
    } catch (err) {
      setProbes((p) => ({
        ...p,
        [id]: { ok: false, mode: "models", status: 0, latencyMs: 0, error: (err as Error).message },
      }));
    }
  };

  const remove = async (model: EvalModel) => {
    if (!window.confirm(`删除模型“${model.label}”？（API key 也会一并删除）`)) return;
    setError(null);
    try {
      await deleteEvalModel(model.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="pill-add" onClick={() => setShowAdd(true)}>
          <PlusIcon className="h-3.5 w-3.5" />
          <span>添加模型</span>
        </button>
        <button type="button" className="pill-add" onClick={() => setShowImport(true)}>
          <BotIcon className="h-3.5 w-3.5" />
          <span>从 OpenCode 导入</span>
        </button>
        <span className="text-xs text-muted">
          共 {models.length} 个模型 · API key 加密存储，接口不回显
        </span>
      </div>

      {error && <div className="bench-sheet__error">{error}</div>}

      {models.length === 0 ? (
        <div className="panel p-6 text-center text-xs text-muted">
          还没有模型。先「从 OpenCode 导入」，或手动添加一个 OpenAI 兼容端点。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((m) => {
            const probe = probes[m.id];
            return (
              <article key={m.id} className="panel flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-[12rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-strong">{m.label}</span>
                    {m.provider && <span className="chip">{m.provider}</span>}
                    {m.apiType === "openai_responses" && <span className="chip">Responses API</span>}
                    {!m.enabled && <span className="chip">已停用</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted break-all">
                    {m.baseUrl} · <span className="text-text">{m.model}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={m.hasKey ? "text-success" : "text-warning"}>
                      {m.hasStoredKey ? "已存 key" : m.hasEnvKey ? `env: ${m.apiKeyEnv}` : "缺少 key"}
                    </span>
                    {probe === "loading" && <span className="text-muted">测试中…</span>}
                    {probe && probe !== "loading" && (
                      <span className={probe.ok ? "text-success" : "text-warning"}>
                        {probe.ok
                          ? `连通 ${probe.latencyMs}ms${probe.modelSeen === false ? "（/models 未列出该模型）" : ""}`
                          : `失败 ${probe.status || ""} ${probe.error || ""}`.trim()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="icon-circle"
                    title="连通性测试"
                    onClick={() => runProbe(m.id)}
                    disabled={probe === "loading"}
                  >
                    <RotateIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="icon-circle"
                    title="编辑"
                    onClick={() => setEditing(m)}
                  >
                    <EditIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="icon-circle"
                    title="删除"
                    onClick={() => remove(m)}
                  >
                    <span className="text-sm leading-none">×</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <EvalModelDialog
        open={showAdd || editing != null}
        model={editing}
        onClose={() => {
          setShowAdd(false);
          setEditing(null);
        }}
        onSaved={() => {
          setShowAdd(false);
          setEditing(null);
          onChanged();
        }}
      />
      <ImportModelsDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => {
          setShowImport(false);
          onChanged();
        }}
      />
    </div>
  );
}
