/**
 * Shared job log viewer + status pill for EvalScope runs.
 */
import { useEffect, useRef } from "react";
import type { EvalScopeJobStatus } from "../../api/types";

export function statusLabel(status: EvalScopeJobStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export function statusClass(status: EvalScopeJobStatus): string {
  switch (status) {
    case "running":
      return "text-accent";
    case "completed":
      return "text-success";
    case "failed":
      return "text-warning";
    default:
      return "text-muted";
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

export function JobLog({
  lines,
  running,
  emptyHint = "日志会在任务开始后出现在这里。",
  maxHeight = "16rem",
}: {
  lines: string[] | undefined;
  running: boolean;
  emptyHint?: string;
  maxHeight?: string;
}) {
  const boxRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <pre
      ref={boxRef}
      onScroll={onScroll}
      style={{ maxHeight }}
      className="overflow-auto rounded border border-border bg-surface-elevated p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all"
    >
      {lines && lines.length > 0 ? (
        lines.join("\n")
      ) : (
        <span className="text-muted">{running ? "等待日志…" : emptyHint}</span>
      )}
    </pre>
  );
}
