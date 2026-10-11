import assert from "node:assert/strict";
import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { installFakeUnit } from "./fakeVulnHunt.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-vh-"));
  fs.writeFileSync(path.join(tmp, "sparks.json"), "[]\n");
  installFakeUnit(tmp);
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      ...isolatedConfigEnv(tmp),
      HOME: tmp,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      LLM_TOKEN_JSON_PATH: path.join(tmp, "llm-tokens.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      FLEET_ENERGY_MONTHLY_JSON_PATH: path.join(tmp, "fleet-energy-monthly.json"),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      GPU_HISTORY_JSON_PATH: path.join(tmp, "gpu-history.json"),
      LLM_LAUNCHERS_JSON_PATH: path.join(tmp, "llm-launchers.json"),
      VULNHUNT_RUNS_PATH: path.join(tmp, "vulnhunt-runs.json"),
      VULNHUNT_RESULTS_DIR: path.join(tmp, "vulnhunt-results"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 6_000)),
  ]);
  return { port, tmp };
}

async function api(port, pathname, init) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("timed out");
}

test("VulnHunter over HTTP: setup, status, validation, a streamed scan, its parsed report, and delete", async (t) => {
  const { port } = await startServer(t);
  const created = await api(port, "/api/sparks", {
    method: "POST",
    body: JSON.stringify({ id: "alpha", name: "alpha", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: os.userInfo().username, auth: "key" } }),
  });
  assert.equal(created.status, 200);
  const base = "/api/sparks/alpha/vulnhunt";

  const setup = await api(port, "/api/vulnhunt/setup");
  assert.equal(setup.status, 200);
  assert.match(setup.body.repository, /VulnHunter/);
  assert.ok(setup.body.steps.length >= 3);
  assert.equal(setup.body.hostCommandFile, "~/.config/sparkdash/vulnhunt-host-cmd");

  assert.equal((await api(port, "/api/sparks/nope/vulnhunt/status")).status, 404);
  const status = await api(port, `${base}/status`);
  assert.equal(status.body.installed, true);
  assert.equal(status.body.ready, true);
  assert.equal(status.body.hostCommand.program, "fake-harness");

  // Validation: attestation, transport, code execution and bounds are all refused with a readable 400.
  const post = (body) => api(port, `${base}/runs`, { method: "POST", body: JSON.stringify(body) });
  const src = { type: "url", value: "https://example.com/org/repo" };
  assert.match((await post({ source: src })).body.error, /authorized/);
  assert.equal((await post({ source: { type: "url", value: "http://example.com/x" }, authorized: true })).status, 400);
  assert.equal((await post({ source: { type: "url", value: "git@example.com:x/y.git" }, authorized: true })).status, 400);
  assert.equal((await post({ source: { type: "path", value: "../../etc" }, authorized: true })).status, 400);
  assert.equal((await post({ source: src, authorized: true, readOnly: false })).status, 400);
  assert.equal((await post({ source: src, authorized: true, timeoutMinutes: 1 })).status, 400);
  assert.equal((await api(port, `${base}/runs`)).body.runs.length, 0, "nothing was stored for refused requests");

  const start = await post({ source: src, authorized: true, label: "ci" });
  assert.equal(start.status, 202);
  const rid = start.body.run.id;
  assert.equal(start.body.run.readOnly, true);
  assert.equal(start.body.run.label, "ci");
  assert.equal((await post({ source: src, authorized: true })).status, 409, "one job per unit");

  const done = await until(async () => {
    const s = await api(port, `${base}/runs/${rid}/stream?lineSince=0`);
    return s.body.live?.job?.status === "completed" ? s.body : null;
  });
  assert.ok(done.live.lines.some((l) => /harness: done/.test(l.text)));
  assert.equal(done.live.progress.stage, "done");

  const fin = await until(async () => {
    const r = await api(port, `${base}/runs/${rid}`);
    return r.body.run.summary ? r.body.run : null;
  });
  assert.equal(fin.status, "completed");
  assert.equal(fin.summary.total, 2);
  assert.equal(fin.summary.counts.High, 1);

  const report = await api(port, `${base}/runs/${rid}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.body.report.findings.length, 2);
  assert.equal(report.body.report.header.model, "test-model");
  assert.ok(report.body.report.artifacts.includes("poc/VULN-001_sql_injection.md"));
  assert.ok(!JSON.stringify(report.body).includes("TOP-SECRET"));

  const events = await api(port, "/api/events?limit=20");
  assert.ok(events.body.events.some((e) => e.type === "vulnhunt.scan.started"));
  assert.ok(events.body.events.some((e) => e.type === "vulnhunt.scan.completed" && /2 confirmed findings/.test(e.message)));

  assert.equal((await api(port, `${base}/runs/${rid}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(port, `${base}/runs/${rid}`)).status, 404);
  assert.equal((await api(port, `${base}/runs/not-a-run-id`)).status, 404);
  assert.equal((await api(port, `${base}/runs`)).body.runs.length, 0);
});
