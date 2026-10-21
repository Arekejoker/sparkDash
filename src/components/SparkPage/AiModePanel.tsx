import { useCallback, useEffect, useRef, useState } from "react";
import type { AiModeStatus } from "../../api/types";
import {
  fetchAiModeLogs,
  fetchAiModeStatus,
  runAiModeAction,
} from "../../api/client";
import { Modal } from "../ui/Modal";
import { RotateIcon } from "../ui/icons";

const MODE_LABEL: Record<string, string> = {
  deepseek: "DeepSeek (DSpark)",
  "deepseek-vision": "DeepSeek Vision (DSpark)",
  "qwen-flash": "Qwen3.8 Flash (双机)",
  "qwen-flash-single": "Qwen3.8 Flash (单机)",
  mix: "Mix (Qwen + ComfyUI + Pixelle)",
  media: "Media (Embedding + ComfyUI)",
  light: "Light (no GPU)",
  glm53: "GLM-5.3 Flash",
  ling: "Ling-3.0 Flash",
  "glm53-decode fast": "GLM-5.3 解码(加速)",
  "glm53-decode stock": "GLM-5.3 解码(标准)",
  "embedding-on": "开启 Embedding",
  "embedding-off": "关闭 Embedding",
  "qwen-flash-single-worker-on": "启动 Worker 单机 Qwen3.8 Flash",
  "qwen-flash-single-worker-off": "停止 Worker 单机 Qwen3.8 Flash",
  partial: "Partial / recovery needed",
};

const TOKEN_KEY = "sparkdash.ai-mode.token";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

type Phase = "confirm" | "running" | "done" | "failed";

/**
 * head: the mutually-exclusive local modes on this host, including the
 *       head-local single-Spark recipe (shares GPU/port 8000 with mix/ling).
 * worker: only the worker-node single-Spark service, an independent toggle on
 *         its own GPU; it does not participate in local mode switching.
 */
type AiModePanelScope = "head" | "worker";

export function AiModePanel({ scope = "head" }: { scope?: AiModePanelScope }) {
  const [status, setStatus] = useState<AiModeStatus | null>(null);
  const [modalAction, setModalAction] = useState<string | null>(null);
  const [dialogToken, setDialogToken] = useState<string>(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  });
  const [phase, setPhase] = useState<Phase>("confirm");
  const [err, setErr] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const sinceRef = useRef(0);
  const logTimer = useRef<number | null>(null);
  const logBody = useRef<HTMLPreElement | null>(null);

  const load = useCallback(() => {
    fetchAiModeStatus()
      .then(setStatus)
      .catch(() => {
        /* keep last known status */
      });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const el = logBody.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(
    () => () => {
      if (logTimer.current) window.clearInterval(logTimer.current);
    },
    []
  );

  function stopPolling() {
    if (logTimer.current) {
      window.clearInterval(logTimer.current);
      logTimer.current = null;
    }
  }

  async function pollOnce() {
    try {
      const res = await fetchAiModeLogs(sinceRef.current);
      if (res.logs.length > 0) {
        setLogs((prev) => [...prev, ...res.logs.map(stripAnsi)]);
        sinceRef.current = res.since + res.logs.length;
      }
      if (res.done) {
        stopPolling();
        setPhase(res.ok ? "done" : "failed");
        if (!res.ok) setErr(res.error || `ai-mode exited with code ${res.code}`);
        load();
      }
    } catch {
      /* transient network error — keep polling */
    }
  }

  function startTracking() {
    setPhase("running");
    setErr(null);
    sinceRef.current = 0;
    setLogs([]);
    void pollOnce();
    logTimer.current = window.setInterval(() => void pollOnce(), 1000);
  }

  async function submit() {
    if (!modalAction) return;
    if (!dialogToken.trim()) {
      setErr("请输入 AUTH_TOKEN");
      return;
    }
    setErr(null);
    try {
      const res = await runAiModeAction(modalAction, dialogToken.trim());
      try {
        localStorage.setItem(TOKEN_KEY, dialogToken.trim());
      } catch {
        /* ignore */
      }
      startTracking();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "switch failed";
      if (/unauthorized|401/i.test(msg)) {
        setErr("AUTH_TOKEN 错误，请重试");
      } else if (/already running/i.test(msg)) {
        setErr("已有切换在进行中，请稍后再试");
      } else if (/too many/i.test(msg)) {
        setErr("请求过于频繁，请稍后再试");
      } else {
        setErr(msg);
      }
    }
  }

  function openRunningLog() {
    setModalAction(status?.mode ?? "?");
    startTracking();
  }

  function closeModal() {
    stopPolling();
    setModalAction(null);
    setPhase("confirm");
    setErr(null);
    setLogs([]);
    load();
  }

  const mode = status?.actualMode || status?.mode || null;
  const health = status?.health ?? null;
  const embeddingDesired = status?.embeddingDesired || "unknown";
  const embeddingActual = status?.embeddingActual || "unknown";
  const embeddingAction = embeddingDesired === "on" && embeddingActual === "healthy" ? "embedding-off" : "embedding-on";
  const serverRunning = status?.running ?? false;
  const transitionState = status?.transitionState ?? "unknown";
  const remoteSingle = status?.remoteSingle ?? null;
  const isStableMode =
    mode === "deepseek" || mode === "deepseek-vision" || mode === "qwen-flash" || mode === "qwen-flash-single" || mode === "mix" || mode === "media" || mode === "light" || mode === "glm53" || mode === "ling";

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-text-strong">
          {scope === "worker" ? "AI Mode — Worker 单机服务" : "AI Mode"}
        </span>
        {scope === "head" && mode && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              mode === "deepseek" || mode === "deepseek-vision"
                ? "bg-accent/15 text-accent"
                : mode === "mix" || mode === "media" || mode === "qwen-flash" || mode === "qwen-flash-single" || mode === "ling"
                  ? "bg-success/15 text-success"
                  : "bg-muted/15 text-muted"
            }`}
          >
            {MODE_LABEL[mode] || mode}
          </span>
        )}
        {scope === "head" && transitionState !== "ready" && transitionState !== "idle" && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
            {transitionState === "failed" ? "recovery required" : transitionState}
          </span>
        )}
        {scope === "head" && health && (
          <span className="flex flex-wrap gap-2 text-[11px] text-muted">
            {Object.entries(health)
              .filter(([, v]) => v)
              .map(([k]) => (
                <span key={k} className="text-success">
                  {k}: up
                </span>
              ))}
          </span>
        )}
        {scope === "head" && (
          <span className={embeddingActual === "healthy" ? "text-[11px] text-success" : "text-[11px] text-muted"}>
            embedding: {embeddingActual} (desired: {embeddingDesired})
          </span>
        )}
        {serverRunning && (
          <button
            type="button"
            onClick={openRunningLog}
            className="flex items-center gap-1.5 text-[11px] text-warning hover:underline"
          >
            <RotateIcon className="h-3 w-3" />
            transition in progress… view logs
          </button>
        )}
      </div>

      {status?.lastError && (
        <div className="mt-2 text-[11px] text-danger">
          Last transition error: {status.lastError}
        </div>
      )}

      {scope === "head" && (status?.api || status?.embedding || status?.comfy) && (
        <div className="mt-2 text-[11px] text-muted">
          {status.api && (
            <>
              API: <code className="rounded bg-surface-elevated px-1.5 py-0.5">{status.api}</code>
              {"  model: "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5">{status.model}</code>
            </>
          )}
          {status.embedding && (
            <>
              {"  Embedding: "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5">{status.embedding}</code>
            </>
          )}
          {status.comfy && (
            <>
              {"  ComfyUI: "}
              <code className="rounded bg-surface-elevated px-1.5 py-0.5">{status.comfy}</code>
            </>
          )}
        </div>
      )}

      {scope === "head" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {["deepseek", "deepseek-vision", "qwen-flash", "qwen-flash-single", "glm53", "ling", "mix", "media", "light"].map((a) => {
            const isCurrent = isStableMode && mode === a;
            return (
              <button
                key={a}
                type="button"
                onClick={() => {
                  if (isCurrent || serverRunning) return;
                  setModalAction(a);
                  setPhase("confirm");
                  setErr(null);
                }}
                disabled={isCurrent || serverRunning}
                title={isCurrent ? "already active" : `switch to ${a}`}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                  isCurrent
                    ? "border-accent/40 text-accent"
                    : "border-border text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {MODE_LABEL[a]}
              </button>
            );
          })}
        </div>
      )}

      {scope === "head" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (serverRunning) return;
              setModalAction(embeddingAction);
              setPhase("confirm");
              setErr(null);
            }}
            disabled={serverRunning}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
          >
            {MODE_LABEL[embeddingAction]}
          </button>
          <span className="text-[11px] text-muted">仅在 Qwen 单机、Mix、Media 和 Light 模式中可开启</span>
        </div>
      )}

      {scope === "worker" && remoteSingle && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (serverRunning || remoteSingle.workerBusyDualNode) return;
              setModalAction(remoteSingle.up ? "qwen-flash-single-worker-off" : "qwen-flash-single-worker-on");
              setPhase("confirm");
              setErr(null);
            }}
            disabled={serverRunning || remoteSingle.workerBusyDualNode}
            title={
              remoteSingle.workerBusyDualNode
                ? "worker 正在运行双机模型 (port 8888)，先停双机再启动单机"
                : remoteSingle.up
                  ? `stop the worker single-Spark service (${remoteSingle.clientUrl ?? "worker"})`
                  : "start Qwen3.8 Flash on the worker (single Spark)"
            }
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
              remoteSingle.up
                ? "border-success/40 text-success hover:bg-surface-hover"
                : "border-border text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            {remoteSingle.up ? "停止 单机 Qwen3.8 Flash" : "启动 单机 Qwen3.8 Flash"}
          </button>
          <span className={remoteSingle.up ? "text-[11px] text-success" : "text-[11px] text-muted"}>
            状态: {remoteSingle.up ? "up" : "down"}
            {!remoteSingle.up && remoteSingle.error ? ` (${remoteSingle.error})` : ""}
          </span>
          {remoteSingle.workerBusyDualNode && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              本机双机模型占用中 (8888)
            </span>
          )}
          {remoteSingle.clientUrl && (
            <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[11px] text-muted">
              {remoteSingle.clientUrl}
            </code>
          )}
          <span className="text-[11px] text-muted">独立于 head 模式切换，可与 head 任何模式共存</span>
        </div>
      )}

      {scope === "worker" && !remoteSingle && (
        <div className="mt-3 text-[11px] text-muted">无法读取 worker 单机服务状态（ai-mode 状态不可用）</div>
      )}

      {mode === "glm53" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">GLM 解码:</span>
          {(["fast", "stock"] as const).map((d) => {
            const current = status?.glm53Decode === d;
            return (
              <button
                key={d}
                type="button"
                disabled={serverRunning || current}
                onClick={() => {
                  if (serverRunning || current) return;
                  setModalAction(`glm53-decode ${d}`);
                  setPhase("confirm");
                  setErr(null);
                }}
                title={current ? "current decode profile" : `switch GLM decode to ${d}`}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                  current
                    ? "border-accent/40 text-accent"
                    : "border-border text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {d === "fast" ? "加速" : "标准"}
              </button>
            );
          })}
          <span className="text-[11px] text-muted">切换需重启 GLM 服务 (~10 分钟)</span>
        </div>
      )}

      {modalAction && (
        <Modal
          title={
            phase === "confirm"
              ? `确认${MODE_LABEL[modalAction]}`
              : phase === "running"
                ? `正在执行${MODE_LABEL[modalAction]}…`
                : phase === "done"
                  ? `已完成${MODE_LABEL[modalAction]}`
                  : `操作失败: ${MODE_LABEL[modalAction]}`
          }
          onClose={closeModal}
        >
          {phase === "confirm" && (
            <div>
              <div className="mb-3 text-xs text-muted">
                此操作会切换模型服务或嵌入能力。输入 AUTH_TOKEN 后点击确认。
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  placeholder="AUTH_TOKEN"
                  value={dialogToken}
                  onChange={(e) => setDialogToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  autoFocus
                  className="w-56 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-text outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => void submit()}
                  className="rounded-md bg-accent px-4 py-2 text-xs font-medium text-white hover:opacity-90"
                >
                  确认执行
                </button>
              </div>
              {err && <div className="mt-3 text-[11px] text-danger">{err}</div>}
            </div>
          )}

          {(phase === "running" || phase === "done" || phase === "failed") && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-accent">
                  {phase === "running"
                    ? `正在执行 ai-mode ${modalAction}…`
                    : phase === "done"
                      ? "操作完成"
                      : "操作失败"}
                </span>
                <span className="text-[11px] text-muted">
                  正在等待服务状态更新
                </span>
              </div>
              <div className="ai-mode-track mt-1.5">
                <div className="ai-mode-fill" />
              </div>
              <pre
                ref={logBody}
                className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border bg-surface-elevated p-3 font-mono text-[11px] leading-relaxed text-text"
              >
                {logs.length > 0 ? logs.join("\n") : "waiting for output…"}
              </pre>
              {phase === "done" && (
                <div className="mt-3 text-[11px] text-success">
                  ✓ 已完成 {MODE_LABEL[modalAction]}
                </div>
              )}
              {phase === "failed" && (
                <div className="mt-3 text-[11px] text-danger">
                  {err || "操作失败，详见上方日志"}
                </div>
              )}
              {(phase === "done" || phase === "failed") && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="rounded-md border border-border px-4 py-2 text-xs text-muted hover:bg-surface-hover hover:text-text"
                  >
                    关闭
                  </button>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
