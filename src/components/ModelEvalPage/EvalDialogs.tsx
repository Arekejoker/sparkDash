/**
 * Dialogs for the Models tab: add/edit one endpoint, or bulk-import the
 * local OpenCode provider/model catalog.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  addEvalModel,
  fetchEvalImportCandidates,
  importEvalModels,
  updateEvalModel,
} from "../../api/client";
import type { EvalImportProvider, EvalModel } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";

interface ShellProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DialogShell({ open, title, subtitle, onClose, children }: ShellProps) {
  const { mounted, visible } = useModalPresence(open);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      <button
        type="button"
        className="bench-overlay__scrim"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div className="bench-sheet" role="dialog" aria-modal="true">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 className="bench-sheet__title">{title}</h2>
            {subtitle && <p className="bench-sheet__subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="bench-sheet__body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bench-field">
      <div className="bench-field__head">
        <span className="bench-sheet__section-title">{label}</span>
        {hint && <p className="bench-sheet__hint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const inputCls = "bench-input w-full";

export function EvalModelDialog({
  open,
  model,
  onClose,
  onSaved,
}: {
  open: boolean;
  model: EvalModel | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiType, setApiType] = useState<"openai_chat" | "openai_responses">("openai_chat");
  const [headersText, setHeadersText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [tokenizerPath, setTokenizerPath] = useState("");
  const [proxy, setProxy] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(model?.label ?? "");
    setProvider(model?.provider ?? "");
    setBaseUrl(model?.baseUrl ?? "");
    setModelName(model?.model ?? "");
    setApiType(model?.apiType ?? "openai_chat");
    setHeadersText(
      model?.headers && Object.keys(model.headers).length ? JSON.stringify(model.headers, null, 2) : ""
    );
    setApiKey("");
    setClearKey(false);
    setApiKeyEnv(model?.apiKeyEnv ?? "");
    setTokenizerPath(model?.tokenizerPath ?? "");
    setProxy(model?.proxy ?? "");
    setEnabled(model?.enabled ?? true);
    setNotes(model?.notes ?? "");
    setError(null);
  }, [open, model]);

  const save = async () => {
    setError(null);
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      setError("baseUrl 需要以 http:// 或 https:// 开头");
      return;
    }
    if (!modelName.trim()) {
      setError("model 不能为空");
      return;
    }
    let headers: Record<string, string> = {};
    const rawHeaders = headersText.trim();
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("需要是 JSON 对象");
        }
        headers = parsed as Record<string, string>;
      } catch (err) {
        setError(`Headers JSON 无效：${(err as Error).message}`);
        return;
      }
    }
    setSaving(true);
    try {
      const body = {
        id: model?.id,
        label: label.trim() || modelName.trim(),
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        model: modelName.trim(),
        apiType,
        headers,
        apiKey: apiKey.trim() || undefined,
        clearApiKey: clearKey || undefined,
        apiKeyEnv: apiKeyEnv.trim(),
        tokenizerPath: tokenizerPath.trim(),
        proxy: proxy.trim(),
        enabled,
        notes: notes.trim(),
      };
      if (model) await updateEvalModel(model.id, body);
      else await addEvalModel(body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      open={open}
      title={model ? "编辑模型" : "添加模型"}
      subtitle="OpenAI 兼容端点（EvalScope 的 --api-url / --api-key）"
      onClose={onClose}
    >
      <section className="bench-sheet__section">
        <Field label="名称" hint="列表里显示的名字，默认用 model id">
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="来源标记" hint="例如 opencode-go / dspark-worker，仅用于分组显示">
          <input className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)} />
        </Field>
        <Field label="Base URL" hint="到 /v1 为止，例如 http://localhost:8000/v1">
          <input
            className={inputCls}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://example.com/v1"
          />
        </Field>
        <Field label="Model ID" hint="请求体里的 model 字段">
          <input className={inputCls} value={modelName} onChange={(e) => setModelName(e.target.value)} />
        </Field>
        <Field
          label="协议"
          hint="OpenAI 兼容的 chat/completions，或 Responses API（如本机 OAuth 桥 /v1/responses）"
        >
          <select
            className={inputCls}
            value={apiType}
            onChange={(e) => setApiType(e.target.value as "openai_chat" | "openai_responses")}
          >
            <option value="openai_chat">Chat Completions（默认）</option>
            <option value="openai_responses">Responses API</option>
          </select>
        </Field>
        <Field
          label="Headers"
          hint='可选，非密请求头 JSON，例如 {"x-opencode-session":"sparkdash-eval"}（eval 走 default_headers，perf 走 --headers）'
        >
          <textarea
            className={`${inputCls} min-h-[64px] font-mono text-[12px]`}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder='{"x-opencode-session":"sparkdash-eval"}'
          />
        </Field>
        <Field
          label="API Key"
          hint={
            model?.hasStoredKey
              ? "已保存（留空则保持原值）"
              : "留空则不出现在请求头；也可用下面的 env 变量"
          }
        >
          <input
            className={inputCls}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={model?.hasStoredKey ? "••••••••" : "sk-…"}
          />
          {model?.hasStoredKey && (
            <label className="mt-1 flex items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              清除已保存的 key
            </label>
          )}
        </Field>
        <Field label="API Key 环境变量" hint="优先级高于已存 key，例如 OPENCODE_API_KEY">
          <input className={inputCls} value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} />
        </Field>
        <Field label="Tokenizer 路径" hint="仅 random 压测数据集需要本地 tokenizer 目录">
          <input
            className={inputCls}
            value={tokenizerPath}
            onChange={(e) => setTokenizerPath(e.target.value)}
            placeholder="~/models/llm/..."
          />
        </Field>
        <Field label="代理" hint="可选，例如 http://127.0.0.1:7897（注入 HTTP(S)_PROXY）">
          <input className={inputCls} value={proxy} onChange={(e) => setProxy(e.target.value)} />
        </Field>
        <Field label="备注">
          <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用（出现在速度/智力测试的下拉里）
        </label>
      </section>

      {error && <p className="bench-sheet__error">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className="pill-item" onClick={onClose} disabled={saving}>
          取消
        </button>
        <button
          type="button"
          className="bench-conc-btn is-on"
          onClick={save}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </DialogShell>
  );
}

export function ImportModelsDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [providers, setProviders] = useState<EvalImportProvider[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    fetchEvalImportCandidates()
      .then((res) => setProviders(res.providers || []))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.map((p) => ({
      ...p,
      models: q ? p.models.filter((m) => m.toLowerCase().includes(q) || p.provider.includes(q)) : p.models,
    }));
  }, [providers, query]);

  const toggle = (provider: string, model: string) => {
    const key = `${provider}::${model}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const doImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const selections = [...selected].map((k) => {
        const [provider, model] = k.split("::");
        return { provider, model };
      });
      const res = await importEvalModels(selections);
      setResult(`已导入 ${res.created.length} 个${res.skipped.length ? `，跳过 ${res.skipped.length} 个` : ""}`);
      setTimeout(onImported, 900);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <DialogShell
      open={open}
      title="从 OpenCode 导入"
      subtitle="读取 opencode.json / auth.json / 模型缓存，key 会复制进加密存储"
      onClose={onClose}
    >
      <section className="bench-sheet__section">
        <input
          className={inputCls}
          placeholder="搜索 provider 或模型…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>已选 {selected.size} 个</span>
          {loading && <span>读取中…</span>}
        </div>
        <div className="flex flex-col gap-2" style={{ maxHeight: "24rem", overflow: "auto" }}>
          {filtered.map((p) => (
            <div key={p.provider} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <strong className="text-text-strong">{p.providerName}</strong>
                {!p.supported && <span className="chip">{p.reason || "不支持"}</span>}
                {p.supported && p.reason && <span className="chip">{p.reason}</span>}
                <span className="text-muted break-all">{p.baseUrl || "无 baseUrl"}</span>
                <span className="text-muted">key: {p.keySource}</span>
                {p.apiType === "openai_responses" && <span className="chip">Responses API</span>}
                {p.headers && Object.keys(p.headers).length > 0 && <span className="chip">带请求头</span>}
              </div>
              {p.supported && p.models.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.models.map((m) => {
                    const key = `${p.provider}::${m}`;
                    const on = selected.has(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`chip${on ? " is-active" : ""}`}
                        style={on ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                        onClick={() => toggle(p.provider, m)}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {!loading && filtered.length === 0 && (
            <p className="bench-sheet__hint">没有可导入的 provider。</p>
          )}
        </div>
      </section>

      {error && <p className="bench-sheet__error">{error}</p>}
      {result && <p className="bench-sheet__hint text-success">{result}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className="pill-item" onClick={onClose} disabled={importing}>
          取消
        </button>
        <button
          type="button"
          className="bench-conc-btn is-on"
          onClick={doImport}
          disabled={importing || selected.size === 0}
        >
          {importing ? "导入中…" : `导入所选（${selected.size}）`}
        </button>
      </div>
    </DialogShell>
  );
}
