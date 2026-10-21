import { fork } from 'node:child_process';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const TAGS = new Set(('svg g defs title desc metadata path rect circle ellipse line polyline polygon text tspan textPath ' +
  'linearGradient radialGradient stop clipPath mask pattern symbol use marker style switch filter feGaussianBlur ' +
  'feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode feDropShadow').split(' ').map(x => x.toLowerCase()));

/** Extract, never repair, the final answer's first complete SVG. */
export function extractSvg(answer) {
  const final = String(answer || '').replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  if (/<think\b/i.test(final)) throw new Error('Unclosed thinking block; no final SVG');
  const match = final.match(/<svg\b[\s\S]*?<\/svg\s*>/i);
  if (!match) throw new Error('No complete SVG in final answer (possibly truncated)');
  return match[0];
}

export function validateSvg(svg) {
  if (Buffer.byteLength(svg) > 512_000) throw new Error('SVG exceeds 512 KB limit');
  if (/<!|<\?/i.test(svg.replace(/<!--[\s\S]*?-->/g, ''))) throw new Error('XML declarations/entities are not allowed');
  const valid = XMLValidator.validate(svg);
  if (valid !== true) throw new Error(`Invalid SVG XML: ${valid.err.msg}`);
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).parse(svg);
  let nodes = 0, text = false;
  const checkValue = (value) => {
    const s = String(value);
    if (/\\|\/\*|@|(?:https?|file|data|javascript):/i.test(s)) throw new Error('External or encoded resources are not allowed');
    for (const match of s.matchAll(/url\s*\(([^)]*)\)/gi)) {
      if (!/^\s*['"]?#[\w.-]+['"]?\s*$/.test(match[1])) throw new Error('Only local fragment URLs are allowed');
    }
  };
  const walk = (items, depth = 0) => {
    if (depth > 64) throw new Error('SVG nesting limit exceeded');
    for (const item of items) {
      for (const [name, children] of Object.entries(item)) {
        if (name === ':@' || name.startsWith('#')) continue;
        if (++nodes > 4000) throw new Error('SVG element limit exceeded');
        if (!TAGS.has(name.toLowerCase())) throw new Error(`Unsupported SVG element: ${name}`);
        if (name.toLowerCase() === 'text' || name.toLowerCase() === 'tspan') text = true;
        for (const [key, value] of Object.entries(item[':@'] || {})) {
          const attr = key.replace(/^@_/, '').toLowerCase();
          if (/^on/.test(attr) || attr === 'xml:base') throw new Error(`Forbidden SVG attribute: ${attr}`);
          if (attr.startsWith('xmlns')) {
            if (!['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'].includes(String(value))) throw new Error('Unsupported XML namespace');
            continue;
          }
          if (attr.endsWith('href') && !/^#[\w.-]+$/.test(String(value))) throw new Error('Only local href references are allowed');
          checkValue(value);
        }
        if (name.toLowerCase() === 'style') for (const c of children) checkValue(c['#text'] || '');
        if (Array.isArray(children)) walk(children, depth + 1);
      }
    }
  };
  walk(parsed);
  return { warnings: text ? ['Contains text: assess the drawing itself, not its labels.'] : [] };
}

/** A disposable process prevents malformed SVG from blocking the dashboard. */
export function renderSvg(svg, signal) {
  const gate = validateSvg(svg);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const child = fork(new URL('./renderWorker.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=128'],
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      error ? reject(error) : resolve({ ...result, png: Buffer.from(result.png, 'base64'), ...gate });
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('SVG rendering exceeded 5 seconds')), 5000);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('message', result => finish(result.error ? new Error(result.error) : null, result));
    child.once('error', err => finish(err));
    child.once('exit', () => finish(new Error('SVG renderer exited without a result')));
    child.send({ svg });
  });
}
