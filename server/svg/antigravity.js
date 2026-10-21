import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const binary = () => process.env.AGY_BIN || path.join(os.homedir(), '.local/bin/agy');
const PREFIX = 'agy/';
const cliEnv = () => {
  const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  if (env.AGY_PROXY_URL) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = env.AGY_PROXY_URL;
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  }
  return env;
};

/** CLI entries belong only to SVG evaluation, not the API/EvalScope registry. */
export function antigravityModel(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  const model = id.slice(PREFIX.length);
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(model)) {
    throw Object.assign(new Error('Invalid Antigravity model slug'), { status: 400 });
  }
  return { id, label: `${model} (Antigravity CLI)`, model,
    apiType: 'antigravity_cli', baseUrl: 'local://antigravity-cli', apiKey: null };
}

export async function antigravityInfo() {
  if (!fs.existsSync(binary())) return { installed: false, version: null, modelsText: '' };
  const { stdout: version } = await exec(binary(), ['--version'], { timeout: 10000, maxBuffer: 100000 });
  try {
    const { stdout } = await exec(binary(), ['models'], { timeout: 15000, maxBuffer: 200000, env: cliEnv() });
    return { installed: true, version: version.trim(), modelsText: stdout.trim() };
  } catch (err) {
    return { installed: true, version: version.trim(), modelsText: '', error: String(err.stderr || err.message).slice(0, 2000) };
  }
}

/** Execute the official client; OAuth credentials stay in its native keyring. */
export async function generateAntigravityAnswer(model, params, prompt, signal, onProgress = () => {}, options = {}) {
  const result = { answer: '', reasoning: '', rawEvents: [], usage: null, finishReason: null, ttftMs: null };
  const started = Date.now();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-agy-'));
  const args = ['-p', prompt, '--disable-slash-commands', '--model', model.model, '--output-format', 'stream-json',
    '--print-timeout', `${params.timeoutSeconds}s`];
  result.execution = { source: 'official Antigravity CLI', model: model.model,
    prompt, newConversation: true, agentContext: true, args,
    sampling: 'CLI defaults; maxTokens, temperature, topP and extraBody are not supported',
    reasoning: 'Only reasoning explicitly exposed by the CLI is retained; token usage may include thinking tokens' };
  let child, timer, forceTimer, abort;
  try {
    if (params.temperature != null || params.topP != null || Object.keys(params.extraBody).length) {
      throw new Error('Antigravity CLI uses its own sampling settings: leave temperature/top_p empty and extra JSON as {}');
    }
    if (signal?.aborted) throw new Error('Cancelled');
    const getVersion = options.getVersion || (async () => (await exec(binary(), ['--version'], { timeout: 10000, maxBuffer: 100000 })).stdout.trim());
    result.execution.clientVersion = await getVersion();
    if (signal?.aborted) throw new Error('Cancelled');
    await new Promise((resolve, reject) => {
      let buffer = '', stderr = '', bytes = 0, terminal = false, stopError = null;
      child = (options.spawn || spawn)(options.binary || binary(), args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: cliEnv(),
      });
      const kill = sig => { try { process.kill(-child.pid, sig); } catch { child.kill(sig); } };
      const stop = message => {
        if (stopError) return;
        stopError = new Error(message); kill('SIGTERM');
        forceTimer = setTimeout(() => kill('SIGKILL'), 1500);
      };
      abort = () => stop('Cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => stop('Antigravity CLI sample timed out'), params.timeoutSeconds * 1000);
      const accept = line => {
        if (!line.trim()) return;
        if (/authentication required/i.test(line) && !line.trimStart().startsWith('{')) {
          stop('Authentication required: run agy in a terminal and sign in with your Google AI Pro account, then retry this evaluation');
          return;
        }
        if (stopError) return;
        const event = JSON.parse(line);
        result.rawEvents.push(event);
        const step = event.step_update;
        if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          result.answer += step.text_delta;
          if (result.ttftMs == null) result.ttftMs = Date.now() - started;
        }
        if (event.event === 'result') {
          terminal = true;
          const envelope = event.result;
          if (typeof envelope?.response === 'string') result.answer = envelope.response;
          result.usage = envelope?.usage || null;
          result.finishReason = envelope?.status || null;
          result.conversationId = envelope?.conversation_id || null;
          if (envelope?.status !== 'SUCCESS') result.error = envelope?.error || `Antigravity status: ${envelope?.status}`;
        }
        onProgress({ ...result, answerChars: result.answer.length, reasoningChars: 0 });
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', text => {
        bytes += Buffer.byteLength(text);
        if (bytes > 8_000_000) return stop('Antigravity CLI output exceeds 8 MB limit');
        buffer += text;
        try {
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          }
        } catch (err) { stop(`Invalid Antigravity CLI event: ${err.message}`); }
      });
      child.stderr.on('data', text => {
        stderr = (stderr + text).slice(-8000);
        if (/authentication required/i.test(stderr)) {
          stop('Authentication required: run agy in a terminal and sign in with your Google AI Pro account, then retry this evaluation');
        }
      });
      child.once('error', reject);
      child.once('close', code => {
        result.diagnostics = stderr;
        try {
          if (!stopError && buffer.trim()) accept(buffer);
          if (stopError) return reject(stopError);
          if (code !== 0) return reject(new Error(result.error || stderr.trim() || `Antigravity CLI exited ${code}`));
          if (!terminal) return reject(new Error('Antigravity CLI ended without a result event'));
          resolve();
        } catch (err) { reject(err); }
      });
    });
  } catch (err) {
    result.error = String(err.message);
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer);
    signal?.removeEventListener('abort', abort);
    result.durationMs = Date.now() - started;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return result;
}
