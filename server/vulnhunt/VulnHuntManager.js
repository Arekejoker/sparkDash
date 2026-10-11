import crypto from "crypto";
import { ToolEvalManager } from "../tooleval/ToolEvalManager.js";
import {
  exitToken,
  buildAttachProgram,
  buildCheckProgram,
  buildDeleteRunProgram,
  buildReadReportProgram,
  buildRunProgram,
  buildStatusProgram,
  buildStopProgram,
} from "./commands.js";
import { summarizeReport } from "./report.js";

const RUN_WATCH_MAX_MS = 13 * 60 * 60 * 1000;
const MAX_LINE_CHARS = 64 * 1024;
const STAGES = new Set(["clone", "hunt", "collect", "done"]);

/** Exit codes the on-unit wrapper uses, as a sentence. */
export function explainExit(code) {
  switch (code) {
    case 0:
      return null;
    case 2:
      return "The source was not usable on the unit.";
    case 3:
      return "The repository could not be cloned.";
    case 4:
      return "The hunt finished but produced no results folder.";
    case 124:
      return "The hunt hit its time limit.";
    case 126:
      return "The harness command is not configured safely on the unit.";
    case 127:
      return "VulnHunter is not fully set up on the unit.";
    case 143:
      return "The scan was stopped.";
    default:
      return code != null ? `The hunt exited with code ${code}.` : null;
  }
}

/**
 * Runs VulnHunter scans on a unit and keeps the dashboard's view of them. Built on the Tool
 * Eval manager's process plumbing (one live job per unit, detached on-unit run, re-attach,
 * result capture), with VulnHunter's own programs, stages and report parsing on top.
 */
export class VulnHuntManager extends ToolEvalManager {
  /** Tool Eval's installer does not apply: the unit's owner sets VulnHunter up (see the setup steps). */
  install() {
    return { ok: false, reason: "unsupported" };
  }

  summary(job) {
    return { ...super.summary(job), stage: job.progress?.stage ?? null };
  }

  _newJob(spark, opts) {
    const job = super._newJob(spark, opts);
    job.progress = { stage: "starting" };
    return job;
  }

  /** One line of output: the exit marker and the wrapper's `stage:` lines are ours, the rest is the harness's. */
  _line(job, line) {
    const token = exitToken(job.nonce);
    const at = line.lastIndexOf(token);
    if (at >= 0) {
      const n = Number.parseInt(line.slice(at + token.length), 10);
      job.markerExit = Number.isFinite(n) ? n : -1;
      line = line.slice(0, at);
      if (!line) return;
    }
    const m = /^\[sparkdash\] stage: ([a-z]+)$/.exec(line);
    if (m && STAGES.has(m[1])) job.progress = { ...job.progress, stage: m[1] };
    job.lseq += 1;
    job.lines.push({ seq: job.lseq, text: line.slice(0, MAX_LINE_CHARS), stream: "out" });
    if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
  }

  async _status(spark) {
    const res = await this.runOnce(spark, buildStatusProgram(), { timeoutMs: 40_000, stdoutOnly: true });
    const kv = {};
    for (const line of res.output.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const source = kv.HOSTCMD_SOURCE || "none";
    const hostConfigured = (source === "env" || source === "file") && kv.HOSTCMD_FOUND === "1";
    const installed = Boolean(kv.VH);
    return {
      reachable: res.ok || kv.VH !== undefined,
      installed,
      path: kv.VH || null,
      git: Boolean(kv.GIT),
      timeout: Boolean(kv.TIMEOUT),
      hostCommand: {
        source,
        program: kv.HOSTCMD_PROGRAM || null,
        found: kv.HOSTCMD_FOUND === "1",
        file: kv.HOSTCMD_FILE || null,
        configured: hostConfigured,
      },
      ready: installed && Boolean(kv.GIT) && Boolean(kv.TIMEOUT) && hostConfigured,
      runRoot: kv.RUNROOT || null,
      error: res.error,
    };
  }

  /**
   * Start a scan (detached on the unit) and follow it.
   * @returns {{ ok: true, job: object } | { ok: false, reason: "busy", active: object }}
   */
  startScan(spark, { run, argv }) {
    const busy = this.activeJob(spark.id);
    if (busy && busy.kind !== "attach") return { ok: false, reason: "busy", active: this.summary(busy) };
    // A scan whose watcher ended (detached, cancelled) may still be running on the unit.
    const orphan = this.store.list({ sparkId: spark.id }).find((r) => r.status === "running" && r.id !== run.id);
    if (orphan) return { ok: false, reason: "busy", active: { id: orphan.id, sparkId: spark.id, kind: "run", status: "running" } };
    if (busy) this._detach(busy, spark);
    const argvB64 = Buffer.from(argv.join("\0") + "\0", "utf8").toString("base64");
    const job = this._newJob(spark, { id: run.id, kind: "run", type: "vulnhunt" });
    const cmd = buildRunProgram({ runId: run.id, argvB64, displayLine: run.command, nonce: job.nonce });
    this._startJob(spark, job, cmd, { maxMs: RUN_WATCH_MAX_MS });
    this.onEvent({
      type: "vulnhunt.scan.started",
      severity: "info",
      sparkId: spark.id,
      message: `VulnHunter scan started${run.label ? ` (${run.label})` : ""}`,
    });
    return { ok: true, job };
  }

  attachScan(spark, run) {
    const busy = this.activeJob(spark.id);
    if (busy) {
      if (busy.id === run.id) return { ok: true, job: busy };
      if (busy.kind === "run") return { ok: false, reason: "busy", active: this.summary(busy) };
      this._detach(busy, spark);
    }
    const job = this._newJob(spark, { id: run.id, kind: "attach", type: "vulnhunt" });
    this._startJob(spark, job, buildAttachProgram({ runId: run.id, nonce: job.nonce }), { maxMs: RUN_WATCH_MAX_MS });
    return { ok: true, job };
  }

  async stopRun(spark, runId) {
    const live = this.jobs.get(spark.id);
    if (live && live.id === runId) live.stopRequested = true;
    const res = await this.runOnce(spark, buildStopProgram({ runId }), { timeoutMs: 40_000 });
    return { ok: res.ok, output: res.output };
  }

  async _afterJob(job, spark) {
    const run = this.store.get(job.id);
    if (!run) return;
    if (job.status === "detached") return; // still unknown; checkRun() settles it later
    if (job.kind === "attach" && job.cancelled) return;
    const finalStatus =
      job.status === "stopped"
        ? "stopped"
        : job.exitCode === 0
          ? "completed"
          : job.exitCode == null && job.status !== "failed"
            ? run.status
            : "failed";
    this.store.update(job.id, {
      status: finalStatus,
      exitCode: job.exitCode,
      finishedAt: job.finishedAt ?? this.now(),
      note: explainExit(job.exitCode),
    });
    await this.captureResult(spark, job.id);
    const fresh = this.store.get(job.id);
    const total = fresh?.summary?.total;
    const c = fresh?.summary?.counts;
    const serious = c ? (c["High+"] ?? 0) + (c.High ?? 0) : 0;
    this.onEvent({
      type: `vulnhunt.scan.${finalStatus}`,
      severity: finalStatus === "completed" ? (serious > 0 ? "warn" : "success") : finalStatus === "stopped" ? "info" : "error",
      sparkId: job.sparkId,
      message:
        finalStatus === "completed"
          ? `VulnHunter scan finished: ${total != null ? `${total} confirmed finding${total === 1 ? "" : "s"}` : "no report"}${serious > 0 ? ` (${serious} High or above)` : ""}`
          : finalStatus === "stopped"
            ? "VulnHunter scan stopped"
            : `VulnHunter scan failed${job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`,
    });
  }

  /** Pull the report bundle from the unit, parse it, cache it locally and keep the headline numbers. */
  async _captureResult(spark, runId) {
    const nonce = crypto.randomBytes(9).toString("hex");
    const S = `__VH_${nonce}_`;
    const res = await this.runOnce(spark, buildReadReportProgram({ runId, sentinel: S }), { timeoutMs: 90_000, stdoutOnly: true });
    if (res.overflow) return { ok: false, reason: "too-big" };
    const text = res.output;
    if (!text.includes(`${S}DIR`)) return { ok: false, reason: "no-result" };

    // The report is last and agent-written; everything before it is parsed by sentinel order.
    const repAt = text.indexOf(`${S}REPORT\n`);
    const head = repAt >= 0 ? text.slice(0, repAt) : text;
    let report = repAt >= 0 ? text.slice(repAt + `${S}REPORT\n`.length) : "";
    if (report.startsWith("__TOOBIG__")) report = "";
    const section = (name, next) => {
      const a = head.indexOf(`${S}${name}\n`);
      if (a < 0) return "";
      const from = a + `${S}${name}\n`.length;
      const b = next ? head.indexOf(`${S}${next}\n`, from) : head.length;
      return head.slice(from, b < 0 ? head.length : b).trim();
    };
    const dir = section("DIR", "MANIFEST").split("\n")[0] ?? "";
    const manifestText = section("MANIFEST", "FILES");
    const files = section("FILES", null)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!this.store.get(runId)) return { ok: false, reason: "deleted" };
    const full = summarizeReport({ report, manifestText, files });
    const bundle = { dir, report, findings: full.findings, artifacts: full.artifacts, header: full.header, manifest: full.manifest };
    if (!this.store.saveBundle(runId, bundle)) return { ok: false, reason: "deleted" };
    this.store.update(runId, {
      resultCached: true,
      summary: {
        hasReport: full.hasReport,
        header: full.header,
        manifest: full.manifest,
        total: full.total,
        counts: full.counts,
        exploitPass: full.exploitPass,
        artifactCount: full.artifacts.length,
        resultsDir: dir || null,
      },
    });
    return { ok: true };
  }

  /** Settle a scan whose watcher was lost: is it still alive, or how did it end? */
  async checkRun(spark, runId) {
    const res = await this.runOnce(spark, buildCheckProgram({ runId }), { timeoutMs: 40_000, stdoutOnly: true });
    const out = res.output.trim().split("\n").pop() ?? "";
    if (out === "ALIVE") return { state: "running" };
    if (out === "GONE") {
      this.store.update(runId, { status: "gone", finishedAt: this.now() });
      return { state: "gone" };
    }
    const m = /^EXIT=(-?\d+)$/.exec(out);
    if (!m) return { state: "unknown" };
    const code = Number.parseInt(m[1], 10);
    const run = this.store.get(runId);
    if (run && run.status === "running") {
      this.store.update(runId, {
        status: code === 0 ? "completed" : code < 0 || code === 143 ? "stopped" : "failed",
        exitCode: code >= 0 ? code : null,
        finishedAt: this.now(),
        note: explainExit(code),
      });
      await this.captureResult(spark, runId);
    }
    return { state: "finished", exitCode: code };
  }

  async removeRemote(spark, runId) {
    if (spark) await this.runOnce(spark, buildDeleteRunProgram({ runId }), { timeoutMs: 40_000, stdoutOnly: true }).catch(() => {});
  }
}
