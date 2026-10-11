/**
 * Programs sparkDash runs on a unit to drive VulnHunter (github.com/nealbridges/VulnHunter).
 * Same approach as Tool Eval (tooleval/commands.js) and the model launchers: each program is
 * shipped base64-encoded so no quoting layer can mangle it, and a scan is DETACHED (setsid)
 * with its output in files under ~/.cache/sparkdash/vulnhunt/<runId>/, so closing the browser
 * or restarting sparkDash never kills a long hunt and the output can be re-attached later.
 *
 * What the unit must provide (sparkDash installs nothing):
 *   - `vh`, the VulnHunter operator CLI (its install.sh puts it in ~/.local/bin)
 *   - the harness's headless one-shot as VULNHUNT_HOST_CMD, taken from the environment or from
 *     the first line of ~/.config/sparkdash/vulnhunt-host-cmd (a file the unit's user owns and
 *     nobody else can write). The command line is NEVER accepted from the dashboard API.
 *
 * The scan sequence is the one VulnHunter's own operator skill and benchmark harness use:
 * `vh clone` -> `vh host <prompt>` (prompt = "/vulnhunt <checkout>") -> `vh find-results`
 * -> `vh write-manifest` -> `vh validate-manifest`.
 */

import { exitToken } from "../tooleval/commands.js";

export { exitToken };

export const RUN_ROOT = "$HOME/.cache/sparkdash/vulnhunt";
export const HOST_CMD_FILE = "$HOME/.config/sparkdash/vulnhunt-host-cmd";
const PATH_LINE = 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"';

export function runDirRef(runId) {
  return `~/.cache/sparkdash/vulnhunt/${runId}`;
}

function wrap(program) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return `bash -c "$(printf %s '${b64}' | base64 -d)"`;
}

const HELPERS = `
# A pid only counts while the run has not written its exit file and the process still looks like our
# wrapper (guards against a recycled pid being mistaken for, or signalled as, the run).
# cmdline is empty for an instant while setsid execs (and for good once the process is a zombie), so retry briefly.
# A pid only counts while it still looks like our wrapper: the run directory is in its arguments.
ours() {
  local c i
  [ -r "/proc/$PID/cmdline" ] || return 0
  for i in 1 2 3 4 5 6; do
    c=$(tr '\\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null)
    [ -n "$c" ] && break
    sleep 0.1
  done
  case "$c" in *"$RD"*) return 0;; esac
  # Between fork and exec the new process still carries this shell's own command line.
  [ "$c" = "$(tr '\\0' ' ' < "/proc/$$/cmdline" 2>/dev/null)" ] && return 0
  return 1
}
alive() { [ "$PID" != 0 ] || return 1; [ -f "$X" ] && return 1; { kill -0 "$PID" 2>/dev/null || kill -0 -- "-$PID" 2>/dev/null; } || return 1; ours; }
follow() {
  tail -n "$1" -F "$L" 2>/dev/null &
  T=$!
  while alive; do sleep 1; done
  sleep 1
  kill "$T" 2>/dev/null
  wait "$T" 2>/dev/null
}
`;

function dirs(runId) {
  return `
RD="${RUN_ROOT}/${runId}"
mkdir -p "$RD" || exit 1
L="$RD/output.log"; X="$RD/exit"; P="$RD/pid"
PID=$(cat "$P" 2>/dev/null || echo 0)
`;
}

/**
 * The detached part: clone, hunt, collect. Arguments: run dir, kind, source, read-only flag
 * ("1"/"0"), time limit in seconds. It always writes <run>/exit, whatever happens.
 */
const INNER = `
RD="$1"; KIND="$2"; VAL="$3"; RO="$4"; TMO="$5"
X="$RD/exit"; P="$RD/pid"; RC=1
trap 'echo "$RC" > "$X"; rm -f "$P"' EXIT
stage() { echo "[sparkdash] stage: $1"; }
export GIT_TERMINAL_PROMPT=0
cd "$RD" || exit 1
rm -rf "$RD/src" "$RD/results-dir" "$RD/before.txt"

stage clone
if [ "$KIND" = url ]; then
  GIT_ALLOW_PROTOCOL=https vh clone "$VAL" --dest "$RD/src" || { echo "[sparkdash] clone failed"; RC=3; exit 3; }
else
  GIT_ALLOW_PROTOCOL=file git clone --depth 1 -- "file://$VAL" "$RD/src" || { echo "[sparkdash] could not clone the local checkout (is it a git repository with a commit?)"; RC=3; exit 3; }
fi
echo "[sparkdash] checked out $(git -C "$RD/src" rev-parse --short HEAD 2>/dev/null || echo unknown) in $RD/src"

# A repository can ship a directory that looks like a results folder: only folders created by THIS hunt count.
vh find-results "$RD/src" > "$RD/before.txt" 2>/dev/null

PF="$RD/prompt.txt"
{
  printf '/vulnhunt %s\\n\\nIMPORTANT: This is running in non-interactive headless mode. Do NOT ask for approval or confirmation. Execute immediately.' "$RD/src"
  [ "$RO" = 1 ] && printf '  Perform a read-only scan, skip instructions related to getting dependencies and executing code'
  printf '\\n'
} > "$PF"

stage hunt
cd "$RD/src" || { RC=3; exit 3; }
# The hunt runs in the background of THIS session so that a stop request (TERM to the whole group)
# and the time limit both reach the harness and everything it started. GNU timeout is avoided on
# purpose: it moves its child into a new process group, which the dashboard's stop cannot reach.
TERMED=""
trap 'TERMED=1; trap "" TERM INT; kill -TERM -- "-$$" 2>/dev/null' TERM INT
vh host "$PF" &
HP=$!
( sleep "$TMO"; : > "$RD/timeout"; echo "[sparkdash] the hunt hit its time limit"; kill -TERM -- "-$$" 2>/dev/null ) &
WD=$!
wait "$HP"; HRC=$?
if [ -n "$TERMED" ]; then
  for i in $(seq 1 30); do kill -0 "$HP" 2>/dev/null || break; sleep 1; done
  kill -0 "$HP" 2>/dev/null && kill -KILL -- "-$$" 2>/dev/null
  wait "$HP" 2>/dev/null; HRC=143
fi
# Everything the hunt left in this session (the time-limit watchdog and its sleep, orphaned harness helpers) goes now;
# this shell ignores the signal, so only the leftovers die.
trap "" TERM INT
kill -TERM -- "-$$" 2>/dev/null
wait 2>/dev/null
[ -f "$RD/timeout" ] && HRC=124
rm -f "$PF" "$RD/timeout"

stage collect
R=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  grep -qxF -- "$d" "$RD/before.txt" 2>/dev/null && continue
  R="$d"; break
done < <(vh find-results "$RD/src" 2>/dev/null)
if [ -n "$R" ]; then
  printf '%s\\n' "$R" > "$RD/results-dir"
  EC=0; [ "$HRC" -eq 0 ] || EC=1
  vh write-manifest "$R" --exit-code "$EC" && vh validate-manifest "$R"
else
  echo "[sparkdash] the hunt produced no new *_VULNHUNT_RESULTS_* directory"
fi
RC=$HRC
if [ "$HRC" -eq 0 ] && [ -z "$R" ]; then RC=4; fi
stage done
exit "$RC"
`;

/** Start a scan (detached) and follow it. `argvB64` is NUL-joined [kind, source, ro, timeoutSeconds], base64. */
export function buildRunProgram({ runId, argvB64, displayLine, nonce = "" }) {
  const TX = exitToken(nonce);
  const displayB64 = Buffer.from(displayLine, "utf8").toString("base64");
  const innerB64 = Buffer.from(INNER, "utf8").toString("base64");
  return wrap(`
${PATH_LINE}
${dirs(runId)}
${HELPERS}
fail() { echo "[sparkdash] $1"; echo "${TX}$2"; exit 0; }
command -v vh >/dev/null 2>&1 || fail "vh (the VulnHunter operator CLI) is not installed on this unit. Open the setup steps on the Security page." 127
command -v git >/dev/null 2>&1 || fail "git is not installed on this unit." 127
command -v timeout >/dev/null 2>&1 || fail "timeout (coreutils) is not installed on this unit." 127
if [ "$PID" != 0 ] && alive; then echo "[sparkdash] this scan is already running"; echo "${TX}-1"; exit 0; fi
mapfile -d '' -t ARGS < <(printf %s '${argvB64}' | base64 -d)
KIND="\${ARGS[0]}"; VAL="\${ARGS[1]}"; RO="\${ARGS[2]}"; TMO="\${ARGS[3]}"
case "$KIND" in url|path) ;; *) fail "unknown source type" 2;; esac

# The harness command lives on the unit, never in the request.
HOSTCMD="\${VULNHUNT_HOST_CMD:-}"
CF="${HOST_CMD_FILE}"
if [ -z "$HOSTCMD" ] && [ -e "$CF" ]; then
  [ -f "$CF" ] && [ ! -L "$CF" ] || fail "$CF must be a regular file, not a link." 126
  [ "$(stat -c %u "$CF")" = "$(id -u)" ] || fail "$CF must be owned by the unit's user." 126
  MODE=$(stat -c %a "$CF"); [ $(( 0$MODE & 022 )) -eq 0 ] || fail "$CF must not be writable by group or others (chmod 600)." 126
  HOSTCMD=$(head -n 1 "$CF")
fi
[ -n "$HOSTCMD" ] || fail "No harness command is configured. Put your harness's headless one-shot on one line in $CF (see the setup steps on the Security page)." 126
FIRST=\${HOSTCMD%% *}
command -v "\${FIRST//\\"/}" >/dev/null 2>&1 || fail "The configured harness command was not found on PATH: \${FIRST}" 126
export VULNHUNT_HOST_CMD="$HOSTCMD"

if [ "$KIND" = path ]; then
  case "$VAL" in "~/"*) VAL="$HOME/\${VAL#\\~/}";; esac
  REAL=$(realpath -e -- "$VAL" 2>/dev/null) || fail "That path does not exist on this unit." 2
  case "$REAL" in "$HOME"/*) ;; *) fail "The path must be inside this unit user's home directory." 2;; esac
  [ -d "$REAL/.git" ] || [ -f "$REAL/.git" ] || fail "That path is not a git checkout." 2
  VAL="$REAL"
fi

rm -f "$X"; : > "$L"
printf '[sparkdash] %s\\n' "$(printf %s '${displayB64}' | base64 -d)" >> "$L"
setsid bash -c "$(printf %s '${innerB64}' | base64 -d)" _ "$RD" "$KIND" "$VAL" "$RO" "$TMO" >> "$L" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$P"
follow "+1"
echo "${TX}$(cat "$X" 2>/dev/null || echo -1)"
`);
}

/** Re-open the output of a scan that is running (or finished). */
export function buildAttachProgram({ runId, nonce = "" }) {
  const TX = exitToken(nonce);
  return wrap(`
${dirs(runId)}
${HELPERS}
[ -f "$L" ] || { echo "[sparkdash] no output was recorded for this scan on the unit"; echo "${TX}-1"; exit 0; }
if [ "$PID" != 0 ] && alive; then follow "+1"; else tail -n +1 "$L" 2>/dev/null; fi
echo "${TX}$(cat "$X" 2>/dev/null || echo -1)"
`);
}

/** Ask a running scan to stop: TERM its process group, KILL after a grace period. */
export function buildStopProgram({ runId }) {
  return wrap(`
${dirs(runId)}
${HELPERS}
for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$P" ] || [ -f "$X" ] && break; sleep 0.5; done
PID=$(cat "$P" 2>/dev/null || echo 0)
if [ "$PID" = 0 ] || ! alive; then echo "not running"; exit 0; fi
kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
for i in 1 2 3 4 5 6 7 8; do alive || break; sleep 1; done
if alive; then kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null; echo "killed"; else echo "stopped"; fi
`);
}

/** Is a scan still alive, and how did it end? Prints ALIVE or EXIT=<code> (or GONE). */
export function buildCheckProgram({ runId }) {
  return wrap(`
${dirs(runId)}
${HELPERS}
[ -d "$RD" ] || { echo GONE; exit 0; }
if [ "$PID" != 0 ] && alive; then echo ALIVE; else echo "EXIT=$(cat "$X" 2>/dev/null || echo -1)"; fi
`);
}

/** What the unit can do today: key=value lines (no secrets; only the harness program's name). */
export function buildStatusProgram() {
  return wrap(`
${PATH_LINE}
echo "VH=$(command -v vh || true)"
echo "GIT=$(command -v git || true)"
echo "TIMEOUT=$(command -v timeout || true)"
HOSTCMD="\${VULNHUNT_HOST_CMD:-}"; SRC=""
CF="${HOST_CMD_FILE}"
if [ -n "$HOSTCMD" ]; then SRC=env
elif [ -e "$CF" ]; then
  if [ -f "$CF" ] && [ ! -L "$CF" ] && [ "$(stat -c %u "$CF")" = "$(id -u)" ] && [ $(( 0$(stat -c %a "$CF") & 022 )) -eq 0 ]; then
    HOSTCMD=$(head -n 1 "$CF"); SRC=file
  else
    SRC=unsafe
  fi
fi
echo "HOSTCMD_SOURCE=\${SRC:-none}"
if [ -n "$HOSTCMD" ]; then
  FIRST=\${HOSTCMD%% *}; FIRST=\${FIRST//\\"/}
  echo "HOSTCMD_PROGRAM=$(basename -- "$FIRST")"
  command -v "$FIRST" >/dev/null 2>&1 && echo "HOSTCMD_FOUND=1" || echo "HOSTCMD_FOUND=0"
fi
echo "HOSTCMD_FILE=${HOST_CMD_FILE}"
echo "RUNROOT=${RUN_ROOT}"
`);
}

/**
 * Print what a finished scan produced, sectioned by per-call sentinels (the report body is
 * agent-written text, so the sentinels carry a nonce it cannot know and the report comes LAST).
 * Symlinks are never followed: a results folder that points outside the checkout reads as empty.
 */
export function buildReadReportProgram({ runId, sentinel, maxReportBytes = 2 * 1024 * 1024 }) {
  const S = sentinel;
  return wrap(`
RD="${RUN_ROOT}/${runId}"
RES=$(head -n 1 "$RD/results-dir" 2>/dev/null)
REALRES=$(realpath -e -- "$RES" 2>/dev/null)
case "$REALRES" in "$RD/src/"*) ;; *) echo "${S}NORESULT"; exit 0;; esac
[ -d "$REALRES" ] && [ ! -L "$RES" ] || { echo "${S}NORESULT"; exit 0; }
cd "$REALRES" || { echo "${S}NORESULT"; exit 0; }
echo "${S}DIR"; basename -- "$REALRES"
echo "${S}MANIFEST"
if [ -f scan_manifest.json ] && [ ! -L scan_manifest.json ] && [ "$(wc -c < scan_manifest.json)" -le 65536 ]; then tr -d '\\n' < scan_manifest.json; echo; fi
echo "${S}FILES"
find . -type f -not -path './.git/*' 2>/dev/null | head -n 600 | sed 's|^\\./||' | grep -E '^[A-Za-z0-9._/@+=,-]{1,200}$'
echo "${S}REPORT"
if [ -f README.md ] && [ ! -L README.md ]; then
  SZ=$(wc -c < README.md)
  if [ "$SZ" -le ${maxReportBytes} ]; then cat README.md; else echo "__TOOBIG__$SZ"; fi
fi
`);
}

export function buildDeleteRunProgram({ runId }) {
  return wrap(`rm -rf "${RUN_ROOT}/${runId}"; echo ok`);
}
