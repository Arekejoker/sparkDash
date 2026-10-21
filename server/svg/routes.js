import express from 'express';
import fs from 'node:fs';
import { svgEvalRunner } from '../collectors/SvgEvalRunner.js';
import { evalScopeRunner } from '../collectors/EvalScopeRunner.js';
import { resolveModel } from '../evalModels.js';
import { antigravityInfo, antigravityModel } from './antigravity.js';

export const svgRouter = express.Router();
const handle = fn => (req, res) => {
  try { fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
svgRouter.get('/jobs', handle((_req, res) => res.json(svgEvalRunner.list())));
svgRouter.get('/antigravity', async (_req, res) => {
  try { res.json(await antigravityInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
svgRouter.post('/jobs', handle((req, res) => {
  if (!Array.isArray(req.body.modelIds)) throw Object.assign(new Error('modelIds must be an array'), { status: 400 });
  const models = [...new Set(req.body.modelIds)].map(id => antigravityModel(id) || resolveModel(id));
  if (models.some(m => m.apiType === 'antigravity_cli') &&
      (req.body.temperature != null || req.body.topP != null || Object.keys(req.body.extraBody || {}).length)) {
    throw Object.assign(new Error('Antigravity CLI: leave temperature/top_p empty and extra JSON as {}'), { status: 400 });
  }
  if (evalScopeRunner.active) throw Object.assign(new Error('Wait for the active EvalScope job to finish'), { status: 409 });
  res.status(202).json(svgEvalRunner.start(req.body, models));
}));
svgRouter.get('/jobs/:id', handle((req, res) => {
  const job = svgEvalRunner.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));
svgRouter.delete('/jobs/:id', handle((req, res) => res.json(svgEvalRunner.cancel(req.params.id))));
svgRouter.get('/jobs/:id/export', handle((req, res) => {
  const job = svgEvalRunner.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.set('Content-Disposition', `attachment; filename="svg-eval-${job.id}.json"`).json({ version: 1, renderer: 'resvg-js / max 1024px / no system fonts', ...job });
}));
svgRouter.get('/assets/:file', handle((req, res) => {
  const file = svgEvalRunner.asset(req.params.file.replace(/\.png$/, ''));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'PNG missing' });
  res.set('X-Content-Type-Options', 'nosniff').type('png').sendFile(file);
}));
svgRouter.post('/jobs/:id/pair', handle((req, res) => res.json(svgEvalRunner.pair(req.params.id))));
svgRouter.post('/votes', handle((req, res) => res.json(svgEvalRunner.vote(req.body.token, req.body.winner))));
