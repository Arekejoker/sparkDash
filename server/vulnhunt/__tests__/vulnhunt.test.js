import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { validateScanRequest, validateSource, scanArgv, displayLine } from "../validate.js";
import { parseFindings, parseHeader, parseManifest, countBySeverity, summarizeReport } from "../report.js";
import { VulnHuntStore, isValidRunId, newRunId } from "../VulnHuntStore.js";
import { VulnHuntManager, explainExit } from "../VulnHuntManager.js";
import { installFakeUnit, REPORT } from "./fakeVulnHunt.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (fn, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("timed out");
};

// ── validation ──────────────────────────────────────────────────────────────

test("source: accepts https repository URLs and absolute checkout paths, normalised", () => {
  assert.deepEqual(validateSource({ type: "url", value: " https://github.com/org/repo.git " }), { ok: true, kind: "url", value: "https://github.com/org/repo.git" });
  assert.equal(validateSource({ type: "url", value: "https://git.lan:8443/team/proj" }).ok, true);
  assert.equal(validateSource({ type: "path", value: "~/code/project" }).ok, true);
  assert.equal(validateSource({ type: "path", value: "/home/me/src/app-1.2" }).ok, true);
});

test("source: rejects transports, credentials, queries, blocked hosts, traversal and shell-looking text", () => {
  const bad = (v) => validateSource(v);
  for (const value of [
    "http://github.com/org/repo",
    "git@github.com:org/repo.git",
    "ssh://git@github.com/org/repo",
    "file:///etc",
    "ext::sh -c id",
    "https://user:pw@github.com/org/repo",
    "https://github.com/org/repo?x=1",
    "https://github.com/org/repo#frag",
    "https://169.254.169.254/latest/meta-data",
    "https://[fe80::1]/x",
    "https://github.com/org/../etc",
    "https://github.com/org/re po",
    "https://github.com/org/repo;id",
    "-u",
    "",
  ]) {
    assert.equal(bad({ type: "url", value }).ok, false, value);
  }
  for (const value of ["relative/path", "/a/../b", "/home/me/a b", "/home/me/$(id)", "/home/me/`id`", "/x;y", "/x\ny", "~", "~root/x"]) {
    assert.equal(bad({ type: "path", value }).ok, false, value);
  }
  assert.equal(bad({ type: "ftp", value: "x" }).ok, false);
  assert.equal(bad(null).ok, false);
});

test("request: needs the authorization attestation; executing code needs its own confirmation", () => {
  const src = { type: "url", value: "https://github.com/org/repo" };
  assert.match(validateScanRequest({ source: src }).error, /authorized/);
  assert.match(validateScanRequest({ source: src, authorized: "yes" }).error, /authorized/);
  const ro = validateScanRequest({ source: src, authorized: true });
  assert.equal(ro.ok, true);
  assert.equal(ro.readOnly, true, "read-only is the default");
  assert.equal(ro.timeoutMinutes, 240);
  assert.match(validateScanRequest({ source: src, authorized: true, readOnly: false }).error, /execute code/);
  assert.equal(validateScanRequest({ source: src, authorized: true, readOnly: false, confirmExecute: true }).readOnly, false);
});

test("request: time limit and label are bounded; control characters never reach the label", () => {
  const base = { source: { type: "path", value: "~/x" }, authorized: true };
  assert.equal(validateScanRequest({ ...base, timeoutMinutes: 4 }).ok, false);
  assert.equal(validateScanRequest({ ...base, timeoutMinutes: 721 }).ok, false);
  assert.equal(validateScanRequest({ ...base, timeoutMinutes: 1.5 }).ok, false);
  assert.equal(validateScanRequest({ ...base, timeoutMinutes: 30 }).timeoutMinutes, 30);
  const r = validateScanRequest({ ...base, label: `a\u0000b\nc${"x".repeat(500)}` });
  assert.ok(r.label.length <= 120 && !/[\u0000-\u001f]/.test(r.label));
  assert.deepEqual(scanArgv({ kind: "url", value: "https://h/x", readOnly: true, timeoutMinutes: 5 }), ["url", "https://h/x", "1", "300"]);
  assert.match(displayLine({ kind: "path", value: "~/x", readOnly: false, timeoutMinutes: 5 }), /may execute code/);
});

// ── report parsing ──────────────────────────────────────────────────────────

test("report: header, findings table and counts are read; markup stays plain text", () => {
  const h = parseHeader(REPORT);
  assert.equal(h.repository, "https://example.com/org/repo");
  assert.equal(h.model, "test-model");
  const f = parseFindings(REPORT);
  assert.deepEqual(f.map((x) => [x.id, x.severity, x.cwe]), [["VULN-001", "High", "CWE-89"], ["VULN-002", "Medium", "CWE-79"]]);
  assert.equal(f[0].measuredImpact, "3 of 20 payloads returned rows");
  assert.equal(f[1].title, "<img src=x onerror=alert(1)> reflected", "kept verbatim as text for the UI to escape");
  assert.deepEqual(countBySeverity(f), { "High+": 0, High: 1, Medium: 1, Low: 0, Informational: 0, unrated: 0 });
});

test("report: tolerant of other layouts, repeated tables and garbage; never throws", () => {
  assert.deepEqual(parseFindings(""), []);
  assert.deepEqual(parseFindings(null), []);
  assert.deepEqual(parseFindings("| not | a | findings | table |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |"), []);
  const twice = `${REPORT}\n\n| ID | Title | CWE | Severity | Status |\n|---|---|---|---|---|\n| **VULN-001** | SQL injection in search (README) | CWE-89 | **High+** | Fixed |\n`;
  const f = parseFindings(twice);
  assert.equal(f.length, 2, "same id twice is one finding");
  assert.equal(f.find((x) => x.id === "VULN-001").severity, "High+");
  const huge = Array.from({ length: 500 }, (_, i) => `| VULN-${String(i).padStart(3, "0")} | t | CWE-1 | Low | static | PASS | n | Confirmed |`).join("\n");
  assert.ok(parseFindings(`| ID | Title | CWE | Severity | Runtime | Exploit Test | Measured Impact | Status |\n|---|---|---|---|---|---|---|---|\n${huge}`).length <= 200, "bounded");
  assert.equal(parseManifest("{not json"), null);
  assert.deepEqual(parseManifest('{"scan_id":"a_VULNHUNT_RESULTS_b","agent_exit_code":0,"cost_usd":0}'), { scanId: "a_VULNHUNT_RESULTS_b", agentExitCode: 0, costUsd: 0 });
  const s = summarizeReport({ report: REPORT, manifestText: "", files: ["poc/a.md"] });
  assert.equal(s.total, 2);
  assert.equal(s.exploitPass, 2);
});

test("store: ids, index limits, bundle round trip and removal", () => {
  const home = tmp("vh-store-");
  const store = new VulnHuntStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "res") });
  const id = newRunId();
  assert.ok(isValidRunId(id));
  assert.equal(isValidRunId("../../etc/passwd"), false);
  assert.equal(isValidRunId("te-20260101-000000-abcd"), false);
  store.add({ id, sparkId: "s1", status: "running" });
  assert.equal(store.saveBundle("vh-20200101-000000-zzzz", {}), false, "unknown run");
  assert.equal(store.saveBundle(id, { report: "x", findings: [] }), true);
  assert.deepEqual(store.loadBundle(id), { report: "x", findings: [] });
  assert.equal(fs.statSync(path.join(home, "runs.json")).mode & 0o077, 0, "index is private");
  assert.equal(store.remove(id), true);
  assert.equal(store.loadBundle(id), null);
});

test("explainExit: every wrapper exit code reads as a sentence", () => {
  for (const c of [2, 3, 4, 124, 126, 127, 143]) assert.ok(explainExit(c));
  assert.equal(explainExit(0), null);
});

// ── pipeline against a fake unit (real bash, real git) ──────────────────────

const spark = { id: "s1", name: "Spark 1" };

function realManager(home) {
  const store = new VulnHuntStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const events = [];
  const mgr = new VulnHuntManager({
    store,
    onEvent: (e) => events.push(e),
    spawnProcess: (_s, cmd, opts = {}) =>
      spawn("bash", ["-c", cmd], {
        env: { ...process.env, HOME: home, PATH: `/usr/local/bin:/usr/bin:/bin`, VULNHUNT_HOST_CMD: "" },
        stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      }),
  });
  return { mgr, store, events };
}

function startScan(mgr, store, over = {}) {
  const request = { kind: "url", value: "https://example.com/org/repo", readOnly: true, timeoutMinutes: 5, ...over.request };
  const id = newRunId();
  const run = { id, sparkId: spark.id, status: "running", startedAt: Date.now(), command: displayLine(request), summary: null };
  store.add(run);
  const argv = over.argv ?? scanArgv(request);
  return { id, started: mgr.startScan(spark, { run, argv }) };
}

const settled = (mgr) => until(() => mgr.latestJob("s1").status !== "running");

test("pipeline: clone -> hunt -> collect; the report is captured and parsed, the prompt is the benchmark prompt", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  const { mgr, store, events } = realManager(home);
  const { id, started } = startScan(mgr, store);
  assert.equal(started.ok, true);
  await settled(mgr);
  await until(() => store.get(id).resultCached);
  const run = store.get(id);
  assert.equal(run.status, "completed");
  assert.equal(run.exitCode, 0);
  assert.equal(run.summary.total, 2);
  assert.equal(run.summary.counts.High, 1);
  assert.equal(run.summary.header.model, "test-model");
  assert.equal(run.summary.manifest.agentExitCode, 0);
  assert.equal(run.summary.findings, undefined, "the index stays small; findings live in the bundle");
  const bundle = store.loadBundle(id);
  assert.equal(bundle.findings.length, 2);
  assert.ok(bundle.artifacts.includes("poc/VULN-001_sql_injection.md"));
  assert.ok(bundle.artifacts.includes("scan_manifest.json"));
  // The prompt the harness received: the skill invocation on the checkout, headless wording, read-only sentence.
  const prompt = fs.readFileSync(path.join(home, "prompt.seen"), "utf8");
  assert.match(prompt, new RegExp(`^/vulnhunt ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.cache/sparkdash/vulnhunt/${id}/src\\n`));
  assert.match(prompt, /non-interactive headless mode/);
  assert.match(prompt, /Perform a read-only scan/);
  const live = mgr.readJob("s1", id, {});
  assert.ok(live.lines.some((l) => /cloned https:\/\/example\.com\/org\/repo/.test(l.text)));
  assert.ok(live.lines.some((l) => /harness: done/.test(l.text)));
  assert.equal(live.progress.stage, "done");
  assert.ok(events.some((e) => e.type === "vulnhunt.scan.completed" && e.severity === "warn" && /2 confirmed findings/.test(e.message)), JSON.stringify(events));
});

test("pipeline: a scan that may execute code does not carry the read-only sentence", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  const { mgr, store } = realManager(home);
  const { id } = startScan(mgr, store, { request: { readOnly: false } });
  await settled(mgr);
  await until(() => store.get(id).status !== "running");
  assert.doesNotMatch(fs.readFileSync(path.join(home, "prompt.seen"), "utf8"), /read-only scan/);
});

test("pipeline: a results folder shipped inside the repository is never mistaken for this hunt's", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  fs.writeFileSync(path.join(home, "plant-results"), "");
  fs.writeFileSync(path.join(home, "no-results"), "");
  const { mgr, store } = realManager(home);
  const { id } = startScan(mgr, store);
  await settled(mgr);
  await until(() => store.get(id).status !== "running");
  const run = store.get(id);
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 4);
  assert.match(run.note, /no results/);
  assert.equal(store.loadBundle(id), null, "the planted report was not captured");
  assert.ok(mgr.readJob("s1", id, {}).lines.some((l) => /no new \*_VULNHUNT_RESULTS_\* directory/.test(l.text)));
});

test("pipeline: a README that is a symlink is not followed out of the results folder", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  fs.writeFileSync(path.join(home, "symlink-readme"), "");
  const { mgr, store } = realManager(home);
  const { id } = startScan(mgr, store);
  await settled(mgr);
  await until(() => store.get(id).resultCached);
  const bundle = store.loadBundle(id);
  assert.equal(bundle.report, "");
  assert.ok(!JSON.stringify(bundle).includes("TOP-SECRET-DO-NOT-LEAK"));
  assert.equal(store.get(id).summary.hasReport, false);
});

test("pipeline: not set up -> clear message and exit 127 / 126, nothing is started", async () => {
  // no vh at all
  let home = tmp("vh-home-");
  let { mgr, store } = realManager(home);
  let r = startScan(mgr, store);
  await settled(mgr);
  assert.equal(mgr.latestJob("s1").exitCode, 127);
  assert.ok(mgr.readJob("s1", r.id, {}).lines.some((l) => /vh .* is not installed/.test(l.text)));
  assert.equal((await mgr.status(spark)).ready, false);

  // vh present, no host command configured
  home = tmp("vh-home-");
  installFakeUnit(home, { hostCmd: null });
  ({ mgr, store } = realManager(home));
  r = startScan(mgr, store);
  await settled(mgr);
  assert.equal(mgr.latestJob("s1").exitCode, 126);
  assert.ok(mgr.readJob("s1", r.id, {}).lines.some((l) => /No harness command is configured/.test(l.text)));
  const st = await mgr.status(spark);
  assert.equal(st.installed, true);
  assert.equal(st.hostCommand.configured, false);
  assert.equal(st.ready, false);
});

test("pipeline: a host command file anyone else can write is refused, and only the program name is reported", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home, { hostCmd: "fake-harness --api-key sk-SECRET-VALUE" });
  const { mgr, store } = realManager(home);
  let st = await mgr.status(spark);
  assert.equal(st.ready, true);
  assert.equal(st.hostCommand.program, "fake-harness");
  assert.ok(!JSON.stringify(st).includes("sk-SECRET-VALUE"), "arguments of the harness command never leave the unit");

  fs.chmodSync(path.join(home, ".config", "sparkdash", "vulnhunt-host-cmd"), 0o666);
  st = await mgr.status(spark);
  assert.equal(st.hostCommand.source, "unsafe");
  assert.equal(st.ready, false);
  const r = startScan(mgr, store);
  await settled(mgr);
  assert.equal(mgr.latestJob("s1").exitCode, 126);
  assert.ok(mgr.readJob("s1", r.id, {}).lines.some((l) => /must not be writable/.test(l.text)));
});

test("pipeline: local checkout mode scans a clone of HEAD, only inside the user's home", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  const repo = path.join(home, "code", "proj");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  const { mgr, store } = realManager(home);

  const ok = startScan(mgr, store, { request: { kind: "path", value: "~/code/proj" } });
  await settled(mgr);
  await until(() => store.get(ok.id).status !== "running");
  assert.equal(store.get(ok.id).status, "completed");
  assert.ok(!fs.readdirSync(repo).some((n) => /VULNHUNT_RESULTS/.test(n)), "the original checkout is left alone");

  const outside = tmp("vh-outside-");
  execFileSync("git", ["init", "-q", outside]);
  const bad = startScan(mgr, store, { request: { kind: "path", value: outside } });
  await settled(mgr);
  assert.equal(mgr.latestJob("s1").exitCode, 2);
  assert.ok(mgr.readJob("s1", bad.id, {}).lines.some((l) => /inside this unit user's home/.test(l.text)));
});

test("pipeline: stop reaches the harness and everything it started; a second scan is refused while one runs", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  fs.writeFileSync(path.join(home, "slow"), "");
  const { mgr, store } = realManager(home);
  const first = startScan(mgr, store);
  await until(() => fs.existsSync(path.join(home, "harness.pid")));
  const hp = Number(fs.readFileSync(path.join(home, "harness.pid"), "utf8"));
  assert.ok(hp > 0);
  const second = startScan(mgr, store);
  assert.equal(second.started.ok, false);
  assert.equal(second.started.reason, "busy");
  store.remove(second.id);

  const res = await mgr.stopRun(spark, first.id);
  assert.match(res.output, /stopped|killed/);
  await settled(mgr);
  await until(() => store.get(first.id).status !== "running");
  assert.equal(store.get(first.id).status, "stopped");
  let alive = true;
  try {
    process.kill(hp, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the harness process is gone");
});

test("pipeline: the time limit ends the hunt (exit 124) and still collects what exists", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  fs.writeFileSync(path.join(home, "slow"), "");
  const { mgr, store } = realManager(home);
  const { id } = startScan(mgr, store, { argv: ["url", "https://example.com/org/repo", "1", "2"] });
  await settled(mgr);
  await until(() => store.get(id).status !== "running");
  const run = store.get(id);
  assert.equal(run.exitCode, 124);
  assert.equal(run.status, "failed");
  assert.match(run.note, /time limit/);
});

test("pipeline: closing the watcher leaves the scan going; attach and refresh settle it", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  fs.writeFileSync(path.join(home, "slow"), "");
  const { mgr, store } = realManager(home);
  const { id } = startScan(mgr, store);
  await until(() => fs.existsSync(path.join(home, "harness.pid")));
  mgr.cancelWatch("s1");
  await until(() => mgr.latestJob("s1").status === "cancelled");
  assert.equal((await mgr.checkRun(spark, id)).state, "running");
  const attach = mgr.attachScan(spark, store.get(id));
  assert.equal(attach.ok, true);
  mgr.cancelWatch("s1");
  await mgr.stopRun(spark, id);
  await until(async () => (await mgr.checkRun(spark, id)).state === "finished");
  assert.notEqual(store.get(id).status, "running");
});

test("pipeline: a clone failure is reported and settles as failed (exit 3)", async () => {
  const home = tmp("vh-home-");
  installFakeUnit(home);
  const { mgr, store } = realManager(home);
  const prev = process.env.FAKE_CLONE_FAIL;
  process.env.FAKE_CLONE_FAIL = "1";
  try {
    const { id } = startScan(mgr, store);
    await settled(mgr);
    await until(() => store.get(id).status !== "running");
    assert.equal(store.get(id).exitCode, 3);
    assert.match(store.get(id).note, /could not be cloned/);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLONE_FAIL;
    else process.env.FAKE_CLONE_FAIL = prev;
  }
});
