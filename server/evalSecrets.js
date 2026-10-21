/**
 * Encrypted API keys for eval model endpoints — a sibling of sparks-secrets.json.
 *
 * Kept in its own file (same AES-256-GCM key as the spark secrets) so that
 * SparkRegistry save cycles never clobber model keys, and vice versa.
 *
 * File shape (v1):
 *   { version: 1, keys: { [modelId]: "<encrypted api key>" } }
 *
 * Keys are NEVER returned by the API; callers only learn whether one exists.
 */
import fs from "fs";
import { EVAL_MODEL_SECRETS_PATH } from "./config.js";
import { encryptSecret, decryptSecret } from "./secretsStore.js";
import { atomicWrite } from "./util/atomicWrite.js";

/**
 * @returns {Map<string, string>} modelId → plaintext api key
 */
export function loadModelApiKeys() {
  /** @type {Map<string, string>} */
  const keys = new Map();
  if (!fs.existsSync(EVAL_MODEL_SECRETS_PATH)) return keys;

  try {
    const data = JSON.parse(fs.readFileSync(EVAL_MODEL_SECRETS_PATH, "utf8"));
    const entries = data?.keys || {};
    for (const [id, blob] of Object.entries(entries)) {
      if (!id || typeof blob !== "string") continue;
      try {
        const key = decryptSecret(blob);
        if (key) keys.set(id, key);
      } catch {
        console.error(
          `[evalSecrets] Failed to decrypt API key for ${id} (wrong/missing key?)`
        );
      }
    }
  } catch (err) {
    console.error(`[evalSecrets] Failed to load model keys: ${err.message}`);
  }
  return keys;
}

/**
 * Persist the whole key map (encrypted). Deletes the file when empty.
 * @param {Map<string, string>} keys
 */
export function saveModelApiKeys(keys) {
  /** @type {Record<string, string>} */
  const out = {};
  if (keys) {
    for (const [id, key] of keys.entries()) {
      if (!id || !key) continue;
      out[id] = encryptSecret(key);
    }
  }

  if (Object.keys(out).length === 0) {
    if (fs.existsSync(EVAL_MODEL_SECRETS_PATH)) {
      try {
        fs.unlinkSync(EVAL_MODEL_SECRETS_PATH);
      } catch (err) {
        throw new Error(`Failed to clear eval model secrets: ${err.message}`);
      }
    }
    return;
  }

  const payload = JSON.stringify({ version: 1, keys: out }, null, 2) + "\n";
  atomicWrite(EVAL_MODEL_SECRETS_PATH, payload, 0o600);
}

/**
 * Read-modify-write helpers (safe for single-process use).
 * @param {string} modelId
 * @returns {string | null}
 */
export function getModelApiKey(modelId) {
  const keys = loadModelApiKeys();
  return keys.get(modelId) ?? null;
}

/**
 * @param {string} modelId
 * @param {string} apiKey
 */
export function setModelApiKey(modelId, apiKey) {
  const keys = loadModelApiKeys();
  const value = String(apiKey || "").trim();
  if (!value) {
    keys.delete(modelId);
  } else {
    keys.set(modelId, value);
  }
  saveModelApiKeys(keys);
}

/**
 * @param {string} modelId
 */
export function deleteModelApiKey(modelId) {
  const keys = loadModelApiKeys();
  if (keys.delete(modelId)) saveModelApiKeys(keys);
}

export { EVAL_MODEL_SECRETS_PATH };
