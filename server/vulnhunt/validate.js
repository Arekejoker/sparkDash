import { isAllowedTargetHost } from "../validate.js";

/**
 * Validation for the one thing a VulnHunter scan request carries: WHAT to scan and how long
 * to let it run. Nothing here is interpolated into a shell string (the values travel as
 * separate NUL-delimited, base64 items, see commands.js), but they are still checked hard so
 * a bad request fails fast with a readable message and a hostile one never reaches the unit.
 *
 * A scan clones the target and then lets an agent harness work on the checkout, so the
 * source is restricted to: an https:// git URL (no credentials, no private-key transports),
 * or an absolute path under the unit user's home directory (confirmed again on the unit).
 */

export const MAX_LABEL = 120;
export const MIN_TIMEOUT_MINUTES = 5;
export const MAX_TIMEOUT_MINUTES = 720;
export const DEFAULT_TIMEOUT_MINUTES = 240;

const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]{1,300}$/;
const LOCAL_PATH_RE = /^(~\/|\/)[A-Za-z0-9._@+=,/-]{1,400}$/;

/**
 * @param {unknown} source `{ type: "url" | "path", value: string }`
 * @returns {{ ok: true, kind: "url" | "path", value: string } | { ok: false, error: string }}
 */
export function validateSource(source) {
  if (!source || typeof source !== "object") return { ok: false, error: "Choose what to scan: a git URL or a path on the unit" };
  const kind = source.type;
  const raw = typeof source.value === "string" ? source.value.trim() : "";
  if (kind !== "url" && kind !== "path") return { ok: false, error: 'Source type must be "url" or "path"' };
  if (!raw) return { ok: false, error: kind === "url" ? "Enter the repository URL" : "Enter the path of a checkout on the unit" };
  if (/[\0\r\n\t ]/.test(raw)) return { ok: false, error: "The source must not contain spaces or control characters" };

  if (kind === "path") {
    if (!LOCAL_PATH_RE.test(raw)) return { ok: false, error: "The path must be absolute (or start with ~/) and use only letters, digits and . _ @ + = , / -" };
    if (raw.split("/").some((seg) => seg === "..")) return { ok: false, error: "The path must not contain .." };
    return { ok: true, kind, value: raw };
  }

  if (raw.length > 300) return { ok: false, error: "The URL is too long" };
  // URL() would silently collapse these, turning one repository path into another.
  if (raw.split("/").some((seg) => seg === ".." || seg === ".")) return { ok: false, error: "The repository path in the URL is not valid" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// repository URLs are supported (use a path for a private checkout already on the unit)" };
  if (u.username || u.password) return { ok: false, error: "The URL must not contain credentials" };
  if (u.search || u.hash) return { ok: false, error: "The URL must not contain a query or fragment" };
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (!isAllowedTargetHost(host)) return { ok: false, error: "That host is not allowed (link-local, metadata and reserved addresses are blocked)" };
  if (!URL_PATH_RE.test(u.pathname) || u.pathname.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: "The repository path in the URL is not valid" };
  }
  return { ok: true, kind, value: `${u.protocol}//${u.host}${u.pathname}` };
}

/**
 * Whole request body -> a normalized scan request, or a readable error.
 * `authorized` is an explicit attestation; the dual-use nature of the tool makes it mandatory.
 */
export function validateScanRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.authorized !== true) {
    return { ok: false, error: "Confirm that you are authorized to scan this code before starting" };
  }
  const src = validateSource(b.source);
  if (!src.ok) return src;

  const readOnly = b.readOnly === false ? false : true;
  // Letting the harness execute code (dependencies, exploit tests) is a separate, explicit decision.
  if (!readOnly && b.confirmExecute !== true) {
    return { ok: false, error: "Allowing the scan to execute code on the unit needs its own confirmation" };
  }

  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  if (b.timeoutMinutes != null) {
    const n = Number(b.timeoutMinutes);
    if (!Number.isInteger(n) || n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
      return { ok: false, error: `Time limit must be a whole number of minutes between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES}` };
    }
    timeoutMinutes = n;
  }

  const label = typeof b.label === "string" ? b.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL) : "";
  return { ok: true, kind: src.kind, value: src.value, readOnly, timeoutMinutes, label };
}

/** The one line shown for a run (history, terminal header). */
export function displayLine({ kind, value, readOnly, timeoutMinutes }) {
  const mode = readOnly ? "read-only" : "may execute code";
  return `vulnhunt ${kind === "url" ? "clone" : "local checkout"} ${value} (${mode}, up to ${timeoutMinutes} min)`;
}

/** Argument list for the on-unit wrapper: kind, source, read-only flag, time limit in seconds. */
export function scanArgv({ kind, value, readOnly, timeoutMinutes }) {
  return [kind, value, readOnly ? "1" : "0", String(timeoutMinutes * 60)];
}
