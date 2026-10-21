/**
 * Gemini Task runner — drives the real Gemini web page (Task mode) through the
 * shared business browser via an external driver script.
 *
 * The driver owns all browser interaction (opens/closes only its own tabs and
 * never touches cookies). This module owns job state, process supervision and
 * persistence. One job at a time: the shared browser and account are serial
 * resources.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../util/atomicWrite.js';

const ROOT = fileURLToPath(new URL('../../config/gemini-task/', import.meta.url));
const DEFAULT_DRIVER = process.env.GEMINI_TASK_DRIVER || path.join(os.homedir(), '.local/share/sparkdash/gemini-web-task/driver.py');
const DEFAULT_PYTHON = process.env.GEMINI_TASK_PYTHON || 'python3';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const idOK = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const ACTIVE = new Set(['submitting', 'running', 'cancelling', 'checking']);
export const AUTH_HINT = '登录失效：请在共享浏览器中打开 gemini.google.com 重新登录后重试';

/** Extract the last complete JSON object from driver stdout (defensive). */
function parseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

export class GeminiTaskRunner {
  constructor({ root = process.env.GEMINI_TASK_DIR || ROOT, driver = DEFAULT_DRIVER,
    python = DEFAULT_PYTHON, spawnImpl = spawn } = {}) {
    this.root = root; this.driver = driver; this.python = python; this.spawn = spawnImpl;
    this.active = null; this.child = null; this.terminate = null; this.cancelled = false;
    this.jobs = []; this.idle = Promise.resolve();
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.json') || !idOK(name.slice(0, -5))) continue;
      let job;
      try { job = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
      catch { continue; }
      job.error ??= null; job.steps ??= []; job.progress ??= null;
      job.screenshot ??= null; job.checkedAt ??= null;
      if (ACTIVE.has(job.status)) {
        job.status = 'interrupted';
        job.error = '服务重启；浏览器端任务可能仍在继续，可用对话链接查看';
        job.completedAt = Date.now();
        delete job.previousStatus;
        this.save(job);
      }
      this.jobs.push(job);
    }
    this.jobs.sort((a, b) => b.startedAt - a.startedAt);
  }

  save(job) { atomicWrite(path.join(this.root, `${job.id}.json`), JSON.stringify(job)); }
  entry(id) { return this.jobs.find(j => j.id === id) || null; }
  get(id) {
    const job = this.entry(id);
    if (!job) return null;
    const { previousStatus, ...rest } = job;
    return rest;
  }
  driverInfo() { return { path: this.driver, installed: fs.existsSync(this.driver) }; }
  list() {
    return {
      activeId: this.active?.id || null,
      driver: this.driverInfo(),
      jobs: this.jobs.map(({ answer, previousStatus, ...rest }) => rest),
    };
  }

  start(body) {
    if (this.active) fail('已有 Gemini 任务在运行', 409);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) fail('Prompt must contain 1–4000 characters');
    const timeoutSeconds = body.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3600) {
      fail('Invalid timeoutSeconds');
    }
    if (!fs.existsSync(this.driver)) fail(`找不到驱动脚本：${this.driver}`, 500);
    const job = {
      id: randomUUID(), prompt, timeoutSeconds, status: 'submitting',
      conversationId: null, url: null, title: null, model: null,
      progress: null, steps: [], answer: null, error: null, screenshot: null,
      startedAt: Date.now(), completedAt: null, durationMs: null,
    };
    this.active = job; this.cancelled = false;
    this.jobs.unshift(job); this.save(job);
    this.idle = this.run(job);
    return job;
  }

  cancel(id) {
    if (!this.active || this.active.id !== id) fail('Job is not running', 404);
    this.cancelled = true;
    this.active.status = 'cancelling'; this.save(this.active);
    this.terminate?.();
    return this.active;
  }

  /** Re-check a finished-but-unresolved job (timeout/failure/cancel) via driver status. */
  refresh(id) {
    if (this.active) fail('已有 Gemini 任务在运行', 409);
    const job = this.entry(id);
    if (!job) fail('Job not found', 404);
    if (!job.conversationId) fail('该任务没有可检查的对话');
    if (job.status === 'complete') fail('任务已完成');
    job.previousStatus = job.status;
    job.status = 'checking'; job.error = null;
    this.save(job);
    this.active = job; this.cancelled = false;
    this.idle = this.runRefresh(job);
    return job;
  }

  async runRefresh(job) {
    try {
      const check = await this.collect(['status', job.conversationId, '--settle', '20'], { timeoutMs: 120000 });
      if (this.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (check.code !== 0) throw new Error(this.describeFailure(check, '检查任务状态失败'));
      const payload = parseJson(check.stdout);
      if (payload?.status === 'complete' && payload.answer) {
        job.status = 'complete';
        job.answer = payload.answer;
        job.steps = payload.steps || [];
        job.title = payload.title || job.title;
        job.model = payload.model || job.model;
        job.error = null;
        job.screenshot = null;
        job.durationMs = null; // true generation time is unknown after a timeout
        job.progress = { status: 'complete', steps: job.steps.length, panels: 1 };
      } else {
        job.status = job.previousStatus || 'timed_out';
        job.error = '再次检查仍未完成；任务可能仍在浏览器端处理，可稍后重试或打开对话查看';
        if (payload?.screenshot) job.screenshot = path.basename(payload.screenshot);
      }
    } catch (err) {
      if (err.cancelled || this.cancelled) {
        job.status = 'cancelled'; job.error = '已取消检查';
      } else {
        job.status = job.previousStatus || 'failed';
        job.error = String(err.message || err);
      }
    } finally {
      delete job.previousStatus;
      job.checkedAt = Date.now();
      try { this.save(job); } finally { this.active = null; this.cancelled = false; }
    }
  }

  /** Serve failure/timeout screenshots the driver wrote, if inside its jobs dir. */
  screenshotPath(id) {
    const job = this.get(id);
    if (!job?.screenshot) fail('No screenshot for this job', 404);
    const name = path.basename(job.screenshot);
    if (!name.endsWith('.png')) fail('No screenshot for this job', 404);
    const file = path.join(path.dirname(this.driver), 'jobs', name);
    return fs.existsSync(file) ? file : fail('Screenshot file missing', 404);
  }

  describeFailure({ code, signal, stderr, stdout }, prefix) {
    const tail = ((stderr || '').trim() || (stdout || '').trim()).slice(-1500);
    if (/AUTH_REQUIRED/i.test(tail)) return AUTH_HINT;
    return `${prefix}（驱动退出 ${code ?? signal}）：${tail || '无输出'}`;
  }

  /** Spawn the driver once; collect output; relay stderr lines; manage kill handle. */
  collect(args, { timeoutMs, onStderrLine } = {}) {
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', settled = false, killTimer = null;
      const child = this.spawn(this.python, [this.driver, ...args], {
        cwd: path.dirname(this.driver), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      this.child = child;
      let stderrBuf = '';
      const terminate = () => {
        try { child.kill('SIGINT'); } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2500);
      };
      this.terminate = terminate;
      const timer = timeoutMs ? setTimeout(terminate, timeoutMs) : null;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer);
        this.child = null; this.terminate = null;
        resolve(result);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', text => { stdout = (stdout + text).slice(-1_000_000); });
      child.stderr.on('data', text => {
        stderr = (stderr + text).slice(-8000);
        if (!onStderrLine) return;
        stderrBuf += text;
        let end;
        while ((end = stderrBuf.indexOf('\n')) !== -1) {
          const line = stderrBuf.slice(0, end).trim();
          stderrBuf = stderrBuf.slice(end + 1);
          if (line) onStderrLine(line);
        }
      });
      child.once('error', err => { finish({ code: null, signal: 'spawn-error' }); reject(err); });
      child.once('close', (code, signal) => finish({ code, signal, stdout, stderr }));
    });
  }

  async run(job) {
    try {
      const submit = await this.collect(['submit', '--prompt', job.prompt], { timeoutMs: 120000 });
      if (this.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (submit.code !== 0) throw new Error(this.describeFailure(submit, '提交任务失败'));
      const info = parseJson(submit.stdout);
      if (!info?.conversationId) throw new Error('驱动未返回对话 ID，无法跟踪任务状态');
      job.conversationId = info.conversationId;
      job.url = info.url || `https://gemini.google.com/u/1/app/${info.conversationId}`;
      job.title = info.title || null;
      job.model = info.model || null;
      job.status = 'running';
      job.progress = { status: info.status || 'running', steps: 0, panels: 0 };
      this.save(job);

      const wait = await this.collect(['wait', job.conversationId,
        '--timeout', String(job.timeoutSeconds), '--interval', '8'],
        { timeoutMs: (job.timeoutSeconds + 120) * 1000, onStderrLine: line => {
          const progress = parseJson(line);
          if (progress && typeof progress === 'object' && 'status' in progress) {
            job.progress = progress;
            this.save(job);
          }
        } });
      if (this.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const payload = parseJson(wait.stdout);
      if (wait.code === 2) {
        job.status = 'timed_out';
        job.error = `等待超时（${job.timeoutSeconds} 秒）；任务可能仍在浏览器端继续，可打开对话链接查看`;
        if (payload?.screenshot) job.screenshot = path.basename(payload.screenshot);
        job.steps = payload?.steps || job.steps;
      } else if (wait.code !== 0) {
        throw new Error(this.describeFailure(wait, '任务等待失败'));
      } else {
        if (!payload || payload.status !== 'complete') throw new Error('驱动结束但未返回完成结果');
        job.status = 'complete';
        job.answer = payload.answer ?? null;
        job.steps = payload.steps || [];
        job.title = payload.title || job.title;
        job.model = payload.model || job.model;
        job.screenshot = null;
      }
    } catch (err) {
      if (err.cancelled || this.cancelled) {
        job.status = 'cancelled';
        job.error = '已取消；任务可能仍在浏览器端继续，可打开对话链接查看';
      } else {
        job.status = 'failed';
        job.error = String(err.message || err);
      }
    } finally {
      job.completedAt = Date.now();
      job.durationMs = job.completedAt - job.startedAt;
      job.progress = job.status === 'complete'
        ? { status: 'complete', steps: job.steps.length, panels: 1 }
        : job.progress;
      try { this.save(job); } finally { this.active = null; this.cancelled = false; }
    }
  }
}

export const geminiTaskRunner = new GeminiTaskRunner();
