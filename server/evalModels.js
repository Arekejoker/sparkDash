/**
 * Eval model registry — external OpenAI-compatible endpoints that EvalScope
 * can benchmark (perf) and evaluate (accuracy) from sparkDash.
 *
 * Config lives in config/eval-models.json (endpoint metadata only; gitignored).
 * API keys live in the encrypted sibling store (config/eval-model-secrets.json)
 * or in an environment variable referenced by `apiKeyEnv`. Keys are never
 * returned by the API — callers only learn whether one exists.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { EVAL_MODELS_PATH } from "./config.js";
import { atomicWrite } from "./util/atomicWrite.js";
import { loadModelApiKeys, setModelApiKey, deleteModelApiKey } from "./evalSecrets.js";

const OPENCODE_AUTH_PATH =
  process.env.OPENCODE_AUTH_PATH || path.join(os.homedir(), ".local/share/opencode/auth.json");
const OPENCODE_CONFIG_PATH =
  process.env.OPENCODE_CONFIG_PATH || path.join(os.homedir(), ".config/opencode/opencode.json");
const OPENCODE_MODELS_CACHE =
  process.env.OPENCODE_MODELS_CACHE || path.join(os.homedir(), ".cache/opencode/models.json");

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
/** Supported wire protocols: chat completions (default) or the Responses API. */
const API_TYPES = new Set(["openai_chat", "openai_responses"]);
const MAX_HEADERS = 20;
const MAX_HEADER_LEN = 512;

function normalizeApiType(value, fallback = "openai_chat") {
  const t = String(value || "").trim();
  return API_TYPES.has(t) ? t : fallback;
}

/** Non-secret request headers (e.g. routing headers required by a gateway). */
function normalizeHeaders(value, fallback = {}) {
  const src = value === undefined ? fallback : value;
  if (!src || typeof src !== "object" || Array.isArray(src)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(src)) {
    const key = String(rawKey || "").trim();
    const val = String(rawValue ?? "").trim();
    if (!key || !val) continue;
    if (key.length > 80 || val.length > MAX_HEADER_LEN) continue;
    if (/^(authorization|api-key|x-api-key|chatgpt-account-id)$/i.test(key)) continue;
    out[key] = val;
    if (Object.keys(out).length >= MAX_HEADERS) break;
  }
  return out;
}

/** Local OpenAI-OAuth bridge (see ~/ai/openai-oauth-bridge). */
const BRIDGE_BASE_URL = (process.env.EVAL_BRIDGE_URL || "http://127.0.0.1:4020").replace(/\/+$/, "");
const BRIDGE_TOKEN = process.env.EVAL_BRIDGE_TOKEN || "local";
const BRIDGE_MODELS = (
  process.env.EVAL_BRIDGE_MODELS || "gpt-6-luna,gpt-6-sol,gpt-5.6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.4,gpt-5.5"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Gateways that route by session header (OpenCode Zen / Go). */
const ZEN_HEADERS = { "x-opencode-session": "sparkdash-eval", "user-agent": "sparkdash/1.9.0" };

function isZenProvider(pid) {
  return pid === "opencode" || pid === "opencode-go";
}

async function isBridgeUp() {
  try {
    const res = await fetch(`${BRIDGE_BASE_URL}/health`, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** @returns {{version: number, models: object[]}} */
function loadRegistry() {
  if (!fs.existsSync(EVAL_MODELS_PATH)) return { version: 1, models: [] };
  try {
    const data = JSON.parse(fs.readFileSync(EVAL_MODELS_PATH, "utf8"));
    const models = Array.isArray(data?.models) ? data.models : [];
    return { version: 1, models: models.filter((m) => m && typeof m.id === "string") };
  } catch (err) {
    console.error(`[evalModels] failed to load registry: ${err.message}`);
    return { version: 1, models: [] };
  }
}

/** @param {{version: number, models: object[]}} reg */
function saveRegistry(reg) {
  atomicWrite(EVAL_MODELS_PATH, JSON.stringify(reg, null, 2) + "\n", 0o644);
}

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** @param {object} model */
function publicModel(model, keyIds) {
  const stored = keyIds.has(model.id);
  const envKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : null;
  return {
    id: model.id,
    label: model.label || model.id,
    provider: model.provider || "",
    baseUrl: model.baseUrl,
    model: model.model,
    apiKeyEnv: model.apiKeyEnv || null,
    apiType: normalizeApiType(model.apiType),
    headers: normalizeHeaders(model.headers),
    hasStoredKey: stored,
    hasEnvKey: Boolean(envKey),
    hasKey: stored || Boolean(envKey),
    tokenizerPath: model.tokenizerPath || null,
    proxy: model.proxy || null,
    enabled: model.enabled !== false,
    notes: model.notes || "",
    createdAt: model.createdAt || null,
    updatedAt: model.updatedAt || null,
  };
}

/** @returns {object[]} */
export function listModels() {
  const reg = loadRegistry();
  const keyIds = new Set(loadModelApiKeys().keys());
  return reg.models.map((m) => publicModel(m, keyIds));
}

/** @param {string} id */
export function getModel(id) {
  return loadRegistry().models.find((m) => m.id === id) || null;
}

/**
 * Resolve runtime connection info for spawning an EvalScope run.
 * @param {string} id
 * @returns {{id: string, label: string, baseUrl: string, model: string, apiKey: string, proxy: string|null, tokenizerPath: string|null}}
 */
export function resolveModel(id) {
  const model = getModel(id);
  if (!model) {
    throw Object.assign(new Error(`Unknown eval model: ${id}`), { status: 404 });
  }
  let apiKey = null;
  if (model.apiKeyEnv && process.env[model.apiKeyEnv]) {
    apiKey = String(process.env[model.apiKeyEnv]).trim();
  }
  if (!apiKey) {
    apiKey = loadModelApiKeys().get(model.id) || null;
  }
  if (!apiKey) {
    throw Object.assign(
      new Error(`No API key configured for ${model.label || model.id} (add one or set ${model.apiKeyEnv || "apiKeyEnv"})`),
      { status: 400 }
    );
  }
  return {
    id: model.id,
    label: model.label || model.id,
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey,
    apiType: normalizeApiType(model.apiType),
    headers: normalizeHeaders(model.headers),
    proxy: model.proxy || null,
    tokenizerPath: model.tokenizerPath || null,
  };
}

/**
 * Create or update a registry entry.
 * @param {object} input
 * @param {string} [input.id]
 * @param {string} input.baseUrl
 * @param {string} input.model
 * @param {string} [input.label]
 * @param {string} [input.provider]
 * @param {string} [input.apiKey] stored encrypted when provided
 * @param {boolean} [input.clearApiKey]
 * @param {string} [input.apiKeyEnv]
 * @param {string} [input.tokenizerPath]
 * @param {string} [input.proxy]
 * @param {boolean} [input.enabled]
 * @param {string} [input.notes]
 */
export function upsertModel(input) {
  const body = input || {};
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw Object.assign(new Error("baseUrl must start with http:// or https://"), { status: 400 });
  }
  const modelName = String(body.model || "").trim();
  if (!modelName) {
    throw Object.assign(new Error("model is required"), { status: 400 });
  }

  const reg = loadRegistry();
  const existing = body.id ? reg.models.find((m) => m.id === body.id) : null;
  const now = new Date().toISOString();

  let id = existing?.id;
  if (!id) {
    const base = slugify(body.id || `${body.provider || "model"}-${modelName}`);
    if (!base) throw Object.assign(new Error("cannot derive a valid id"), { status: 400 });
    id = base;
    let n = 2;
    while (reg.models.some((m) => m.id === id)) id = `${base}-${n++}`;
  }
  if (!ID_RE.test(id)) {
    throw Object.assign(new Error(`invalid id: ${id}`), { status: 400 });
  }

  /** @type {object} */
  const entry = {
    id,
    label: String(body.label || existing?.label || modelName).trim(),
    provider: String(body.provider || existing?.provider || "").trim(),
    baseUrl,
    model: modelName,
    apiType: normalizeApiType(body.apiType, normalizeApiType(existing?.apiType)),
    headers:
      body.headers !== undefined ? normalizeHeaders(body.headers) : normalizeHeaders(existing?.headers),
    apiKeyEnv: body.apiKeyEnv !== undefined ? String(body.apiKeyEnv || "").trim() : existing?.apiKeyEnv || "",
    tokenizerPath:
      body.tokenizerPath !== undefined
        ? String(body.tokenizerPath || "").trim()
        : existing?.tokenizerPath || "",
    proxy: body.proxy !== undefined ? String(body.proxy || "").trim() : existing?.proxy || "",
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled !== false,
    notes: body.notes !== undefined ? String(body.notes || "").trim() : existing?.notes || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existing) {
    reg.models = reg.models.map((m) => (m.id === id ? entry : m));
  } else {
    reg.models.push(entry);
  }
  saveRegistry(reg);

  const apiKey = body.apiKey != null ? String(body.apiKey).trim() : "";
  if (apiKey) setModelApiKey(id, apiKey);
  else if (body.clearApiKey) deleteModelApiKey(id);

  return publicModel(entry, new Set(loadModelApiKeys().keys()));
}

/** @param {string} id */
export function deleteModel(id) {
  const reg = loadRegistry();
  const before = reg.models.length;
  reg.models = reg.models.filter((m) => m.id !== id);
  if (reg.models.length === before) {
    throw Object.assign(new Error(`Unknown eval model: ${id}`), { status: 404 });
  }
  saveRegistry(reg);
  deleteModelApiKey(id);
  return { ok: true };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build import candidates from the local OpenCode install.
 *
 * Sources:
 *   - ~/.config/opencode/opencode.json  (user providers: baseURL + literal key + models)
 *   - ~/.local/share/opencode/auth.json (api-key providers; base URL from the catalog cache)
 *   - ~/.cache/opencode/models.json     (provider catalog: api base URL + model list + env var)
 *
 * Candidate objects never contain key material — only `keySource`.
 */
export async function getImportCandidates() {
  const oc = readJsonIfExists(OPENCODE_CONFIG_PATH) || {};
  const auth = readJsonIfExists(OPENCODE_AUTH_PATH) || {};
  const catalog = readJsonIfExists(OPENCODE_MODELS_CACHE) || {};
  const bridgeUp = await isBridgeUp();

  const providers = new Map();

  const ensure = (pid) => {
    if (!providers.has(pid)) {
      providers.set(pid, {
        provider: pid,
        providerName: catalog[pid]?.name || pid,
        baseUrl: "",
        keySource: "none",
        supported: true,
        reason: "",
        apiType: "openai_chat",
        headers: {},
        models: [],
      });
    }
    return providers.get(pid);
  };

  // User-configured providers in opencode.json
  for (const [pid, p] of Object.entries(oc.provider || {})) {
    const entry = ensure(pid);
    const opts = p?.options || {};
    if (opts.baseURL) entry.baseUrl = normalizeBaseUrl(opts.baseURL);
    if (opts.apiKey) entry.keySource = "opencode.json";
    const models = Object.keys(p?.models || {});
    entry.models = models;
    if (!entry.baseUrl && catalog[pid]?.api) entry.baseUrl = normalizeBaseUrl(catalog[pid].api);
    if (isZenProvider(pid)) entry.headers = { ...ZEN_HEADERS };
    if (p?.npm === "@ai-sdk/anthropic" || /\/anthropic\/?$/.test(entry.baseUrl)) {
      entry.supported = false;
      entry.reason = "Anthropic-format endpoint — needs an OpenAI-compatible base URL";
    }
  }

  // Providers with credentials in auth.json
  for (const [pid, a] of Object.entries(auth)) {
    const entry = ensure(pid);
    if (isZenProvider(pid)) entry.headers = { ...ZEN_HEADERS };
    if (a?.type === "oauth") {
      if (pid === "openai" && bridgeUp) {
        entry.baseUrl = `${BRIDGE_BASE_URL}/v1`;
        entry.keySource = "bridge";
        entry.apiType = "openai_responses";
        entry.models = [...BRIDGE_MODELS];
        entry.reason = "via local openai-oauth-bridge (opencode ChatGPT login)";
        continue;
      }
      entry.supported = false;
      entry.reason =
        pid === "openai"
          ? `OAuth login — start the local bridge (${BRIDGE_BASE_URL}) to import these`
          : "OAuth login — EvalScope needs an API-key endpoint";
      if (!entry.baseUrl && catalog[pid]?.api) entry.baseUrl = normalizeBaseUrl(catalog[pid].api);
      if (!entry.models.length) entry.models = Object.keys(catalog[pid]?.models || {});
      continue;
    }
    if (a?.type === "api" && a?.key) {
      if (entry.keySource === "none") entry.keySource = "auth.json";
      if (!entry.baseUrl && catalog[pid]?.api) entry.baseUrl = normalizeBaseUrl(catalog[pid].api);
      if (!entry.models.length) entry.models = Object.keys(catalog[pid]?.models || {});
    }
  }

  // Env-var override hint from the catalog (e.g. OPENCODE_API_KEY)
  for (const [pid, entry] of providers.entries()) {
    const envName = catalog[pid]?.env?.[0] || "";
    entry.apiKeyEnv = envName && process.env[envName] ? envName : "";
    if (catalog[pid]?.npm === "@ai-sdk/anthropic" || /\/anthropic\/?$/.test(entry.baseUrl)) {
      entry.supported = false;
      entry.reason = entry.reason || "Anthropic-format endpoint — needs an OpenAI-compatible base URL";
    }
    if (!entry.baseUrl || !entry.models.length) {
      entry.supported = false;
      entry.reason = entry.reason || "no base URL or model list available";
    }
  }

  return { providers: [...providers.values()], bridgeUp };
}

/**
 * Import selected (provider, model) pairs into the registry.
 * @param {{provider: string, model: string, label?: string}[]} selections
 */
export async function applyImport(selections) {
  const oc = readJsonIfExists(OPENCODE_CONFIG_PATH) || {};
  const auth = readJsonIfExists(OPENCODE_AUTH_PATH) || {};
  const catalog = readJsonIfExists(OPENCODE_MODELS_CACHE) || {};
  const bridgeUp = await isBridgeUp();

  const created = [];
  const skipped = [];

  for (const sel of Array.isArray(selections) ? selections : []) {
    const pid = String(sel?.provider || "").trim();
    const modelName = String(sel?.model || "").trim();
    if (!pid || !modelName) {
      skipped.push({ provider: pid, model: modelName, reason: "missing provider/model" });
      continue;
    }

    // ChatGPT OAuth providers are reachable through the local Responses bridge.
    const viaBridge = pid === "openai" && auth[pid]?.type === "oauth";
    if (viaBridge && !bridgeUp) {
      skipped.push({ provider: pid, model: modelName, reason: `local bridge not reachable at ${BRIDGE_BASE_URL}` });
      continue;
    }

    const userProvider = oc.provider?.[pid] || {};
    const baseUrl = viaBridge
      ? `${BRIDGE_BASE_URL}/v1`
      : normalizeBaseUrl(userProvider?.options?.baseURL || catalog[pid]?.api || "");
    if (!baseUrl) {
      skipped.push({ provider: pid, model: modelName, reason: "no base URL" });
      continue;
    }

    const envName = catalog[pid]?.env?.[0] || "";
    const envKey = envName && process.env[envName] ? String(process.env[envName]).trim() : "";
    const literalKey = viaBridge
      ? BRIDGE_TOKEN
      : String(userProvider?.options?.apiKey || "").trim() ||
        (auth[pid]?.type === "api" ? String(auth[pid]?.key || "").trim() : "");

    try {
      const entry = upsertModel({
        id: slugify(`${pid}-${modelName}`),
        label: `${modelName}`,
        provider: pid,
        baseUrl,
        model: modelName,
        apiType: viaBridge ? "openai_responses" : "openai_chat",
        headers: viaBridge ? {} : isZenProvider(pid) ? { ...ZEN_HEADERS } : {},
        apiKeyEnv: envKey && !viaBridge ? envName : "",
        apiKey: envKey && !viaBridge ? "" : literalKey,
        notes: viaBridge
          ? `imported from opencode (${pid}, via local openai-oauth-bridge)`
          : `imported from opencode (${pid})`,
      });
      created.push(entry);
    } catch (err) {
      skipped.push({ provider: pid, model: modelName, reason: err.message });
    }
  }

  return { created, skipped };
}

const PROBE_TIMEOUT_MS = 12_000;

/**
 * Connectivity check: GET {baseUrl}/models, falling back to a 1-token chat
 * completion for endpoints that do not implement /models.
 * @param {string} id
 */
export async function probeModel(id) {
  const conn = resolveModel(id);
  const headers = { Authorization: `Bearer ${conn.apiKey}`, ...conn.headers };
  const started = Date.now();

  const fetchWithTimeout = async (url, init) => {
    return fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  };

  try {
    const res = await fetchWithTimeout(`${conn.baseUrl}/models`, { headers });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
      return {
        ok: true,
        mode: "models",
        status: res.status,
        latencyMs: Date.now() - started,
        modelCount: ids.length,
        modelSeen: ids.includes(conn.model),
      };
    }
    if (res.status !== 404 && res.status !== 405) {
      return {
        ok: false,
        mode: "models",
        status: res.status,
        latencyMs: Date.now() - started,
        error: (await res.text().catch(() => "")).slice(0, 300) || `HTTP ${res.status}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      mode: "models",
      status: 0,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }

  try {
    const res = await fetchWithTimeout(`${conn.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: conn.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    const text = res.ok ? "" : await res.text().catch(() => "");
    return {
      ok: res.ok,
      mode: "chat",
      status: res.status,
      latencyMs: Date.now() - started,
      error: res.ok ? "" : text.slice(0, 300) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      mode: "chat",
      status: 0,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}
