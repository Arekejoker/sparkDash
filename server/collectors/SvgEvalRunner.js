import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../util/atomicWrite.js';
import { generateSvgAnswer } from '../svg/generate.js';
import { extractSvg, renderSvg } from '../svg/render.js';

export const SVG_PRESETS = [
  { id: 'pelican', label: '鹈鹕骑自行车（原题）', prompt: 'Generate an SVG of a pelican riding a bicycle' },
  { id: 'flamingo', label: '火烈鸟骑独轮车', prompt: 'Generate an SVG of a flamingo riding a unicycle' },
  { id: 'capybara', label: '水豚玩滑板', prompt: 'Generate an SVG of a capybara riding a skateboard' },
  { id: 'octopus', label: '章鱼骑滑板车', prompt: 'Generate an SVG of an octopus riding a scooter' },
];
const ROOT = fileURLToPath(new URL('../../config/svg-eval/', import.meta.url));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const idOK = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

export function svgParams(body) {
  const number = (key, fallback, min, max, integer = false) => {
    const value = body[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`Invalid ${key}`);
    return value;
  };
  const extraBody = body.extraBody ?? {};
  if (!extraBody || Array.isArray(extraBody) || typeof extraBody !== 'object' || JSON.stringify(extraBody).length > 8000) fail('extraBody must be a JSON object, <= 8 KB');
  const reserved = new Set(['model', 'messages', 'input', 'stream', 'stream_options', 'store', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'n', 'tools', 'tool_choice', 'background']);
  for (const key of Object.keys(extraBody)) if (reserved.has(key)) fail(`extraBody cannot override ${key}`);
  return {
    repetitions: number('repetitions', 3, 1, 10, true),
    maxTokens: number('maxTokens', 8192, 128, 65536, true),
    temperature: body.temperature == null ? null : number('temperature', null, 0, 2),
    topP: body.topP == null ? null : number('topP', null, 0.01, 1),
    timeoutSeconds: number('timeoutSeconds', 300, 10, 1800, true),
    extraBody, notes: String(body.notes || '').slice(0, 2000),
  };
}

export class SvgEvalRunner {
  constructor({ root = process.env.SVG_EVAL_DIR || ROOT, generate = generateSvgAnswer, render = renderSvg } = {}) {
    this.root = root; this.generate = generate; this.render = render;
    this.active = null; this.controller = null; this.jobs = []; this.pairs = new Map();
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.json') || !idOK(name.slice(0, -5))) continue;
      const job = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
      if (job.status === 'running' || job.status === 'cancelling') {
        job.status = 'interrupted'; job.completedAt = Date.now();
        for (const sample of job.samples) if (['running', 'pending'].includes(sample.status)) {
          sample.status = 'interrupted'; sample.error = 'Server restarted; sample was not retried';
        }
        this.save(job);
      }
      this.jobs.push(job);
    }
    this.jobs.sort((a, b) => b.startedAt - a.startedAt);
  }
  save(job) { atomicWrite(path.join(this.root, `${job.id}.json`), JSON.stringify(job)); }
  get(id) { return this.jobs.find(j => j.id === id) || null; }
  list() {
    return { presets: SVG_PRESETS, activeId: this.active?.id || null, jobs: this.jobs.map(j => ({
      ...j, samples: j.samples.map(({ answer, reasoning, rawEvents, svg, ...s }) => s),
    })) };
  }
  start(body, models) {
    if (this.active) fail('An SVG evaluation is already running', 409);
    const params = svgParams(body);
    if (!models.length || models.length > 8) fail('Select 1–8 models');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) fail('Prompt must contain 1–8000 characters');
    const job = { id: randomUUID(), prompt, params, startedAt: Date.now(), completedAt: null, status: 'running', votes: [], samples: [] };
    for (let repeat = 1; repeat <= params.repetitions; repeat++) for (const m of models) {
      job.samples.push({ id: randomUUID(), modelId: m.id, modelLabel: m.label, model: m.model, baseUrl: m.baseUrl,
        apiType: m.apiType, repetition: repeat, status: 'pending', error: null });
    }
    this.active = job; this.controller = new AbortController(); this.jobs.unshift(job); this.save(job);
    void this.run(job, models, this.controller.signal);
    return job;
  }
  async run(job, models, signal) {
    try {
      for (const sample of job.samples) {
        if (signal.aborted) break;
        sample.status = 'running'; sample.startedAt = Date.now(); this.save(job);
        const model = models.find(m => m.id === sample.modelId);
        try {
          let checkpointAt = 0;
          Object.assign(sample, await this.generate(model, job.params, job.prompt, signal, progress => {
            Object.assign(sample, progress);
            if (Date.now() - checkpointAt > 3000) { this.save(job); checkpointAt = Date.now(); }
          }));
          sample.truncated = ['length', 'max_output_tokens'].includes(sample.finishReason);
          // Save original answer even if XML validation or rendering fails.
          this.save(job);
          if (sample.error) throw new Error(sample.error);
          if (sample.finishReason === 'tool_calls' && !/<svg\b[\s\S]*?<\/svg\s*>/i.test(sample.answer)) {
            throw new Error('Model returned tool calls instead of an SVG; tools were not executed');
          }
          sample.svg = extractSvg(sample.answer);
          const rendered = await this.render(sample.svg, signal);
          fs.writeFileSync(path.join(this.root, `${sample.id}.png`), rendered.png, { mode: 0o600 });
          Object.assign(sample, { status: 'completed', width: rendered.width, height: rendered.height,
            warnings: rendered.warnings });
        } catch (err) {
          sample.status = signal.aborted ? 'cancelled' : 'failed';
          sample.error = model.apiKey ? String(err.message).split(model.apiKey).join('***') : String(err.message);
        }
        sample.completedAt = Date.now(); sample.durationMs = sample.completedAt - sample.startedAt;
        this.save(job);
      }
      job.status = signal.aborted ? 'cancelled' : job.samples.every(s => s.status === 'completed') ? 'completed' : 'completed_with_errors';
      for (const sample of job.samples) if (sample.status === 'pending') sample.status = 'cancelled';
    } catch (err) {
      job.status = 'failed'; job.error = 'Could not persist evaluation result';
      for (const sample of job.samples) if (['running', 'pending'].includes(sample.status)) sample.status = 'interrupted';
    } finally {
      job.completedAt = Date.now();
      try { this.save(job); } finally { this.active = null; this.controller = null; }
    }
  }
  cancel(id) {
    if (this.active?.id !== id) fail('Job is not running', 404);
    this.active.status = 'cancelling'; this.controller.abort(); this.save(this.active);
    return this.active;
  }
  asset(sampleId) {
    if (!idOK(sampleId)) fail('Invalid sample ID');
    const sample = this.jobs.flatMap(j => j.samples).find(s => s.id === sampleId);
    if (!sample || sample.status !== 'completed') fail('Rendered sample not found', 404);
    return path.join(this.root, `${sampleId}.png`);
  }
  pair(jobId) {
    const job = this.get(jobId);
    if (!job) fail('Job not found', 404);
    const samples = job.samples.filter(s => s.status === 'completed');
    const options = [];
    for (let i = 0; i < samples.length; i++) for (let k = i + 1; k < samples.length; k++) {
      if (samples[i].modelId !== samples[k].modelId) options.push([samples[i], samples[k]]);
    }
    if (!options.length) fail('Blind comparison needs rendered samples from at least two models');
    if (this.pairs.size > 200) this.pairs.clear();
    const [a, b] = options[randomInt(options.length)].sort(() => randomInt(2) ? 1 : -1);
    const token = randomUUID();
    this.pairs.set(token, { jobId, a: a.id, b: b.id, expires: Date.now() + 3600_000 });
    return { token, prompt: job.prompt, a: `/api/svg/assets/${a.id}.png`, b: `/api/svg/assets/${b.id}.png` };
  }
  vote(token, winner) {
    const pair = this.pairs.get(token);
    if (!pair || pair.expires < Date.now()) fail('Blind comparison expired');
    if (!['a', 'b', 'tie'].includes(winner)) fail('Choose a, b, or tie');
    const job = this.get(pair.jobId);
    job.votes.push({ a: pair.a, b: pair.b, winner, at: Date.now() }); this.save(job); this.pairs.delete(token);
    return { a: job.samples.find(s => s.id === pair.a).modelLabel, b: job.samples.find(s => s.id === pair.b).modelLabel };
  }
}

export const svgEvalRunner = new SvgEvalRunner();
