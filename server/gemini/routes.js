import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { geminiTaskRunner } from './runner.js';

const exec = promisify(execFile);
export const geminiRouter = express.Router();
const handle = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

geminiRouter.get('/driver', handle(async (_req, res) => {
  let python = null;
  try { python = (await exec('python3', ['--version'], { timeout: 10000 })).stdout.trim(); }
  catch { /* python3 not runnable */ }
  res.json({ ...geminiTaskRunner.driverInfo(), python });
}));
geminiRouter.get('/jobs', handle((_req, res) => res.json(geminiTaskRunner.list())));
geminiRouter.post('/jobs', handle((req, res) => res.status(202).json(geminiTaskRunner.start(req.body || {}))));
geminiRouter.get('/jobs/:id', handle((req, res) => {
  const job = geminiTaskRunner.get(req.params.id);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  res.json(job);
}));
geminiRouter.delete('/jobs/:id', handle((req, res) => res.json(geminiTaskRunner.cancel(req.params.id))));
geminiRouter.post('/jobs/:id/refresh', handle((req, res) => res.status(202).json(geminiTaskRunner.refresh(req.params.id))));
geminiRouter.get('/jobs/:id/screenshot', handle((req, res) => {
  const file = geminiTaskRunner.screenshotPath(req.params.id);
  res.set('X-Content-Type-Options', 'nosniff').type('png').sendFile(file);
}));
