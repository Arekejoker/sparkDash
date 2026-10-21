import { fetch, ProxyAgent } from 'undici';
import { generateAntigravityAnswer } from './antigravity.js';

export function generationBody(model, params, prompt) {
  const responses = model.apiType === 'openai_responses';
  const body = responses
    ? { model: model.model, input: prompt, max_output_tokens: params.maxTokens, stream: true, store: false }
    : { model: model.model, messages: [{ role: 'user', content: prompt }], max_tokens: params.maxTokens, stream: true, stream_options: { include_usage: true } };
  if (params.temperature != null) body.temperature = params.temperature;
  if (params.topP != null) body.top_p = params.topP;
  Object.assign(body, params.extraBody);
  return body;
}

/** SSE and non-streaming-compatible gateways; partial outputs survive errors. */
export async function generateSvgAnswer(model, params, prompt, signal, onProgress = () => {}) {
  if (model.apiType === 'antigravity_cli') return generateAntigravityAnswer(model, params, prompt, signal, onProgress);
  const result = { answer: '', reasoning: '', rawEvents: [], usage: null, finishReason: null, ttftMs: null, durationMs: 0 };
  const started = Date.now();
  const proxy = model.proxy || process.env.EVAL_DEFAULT_PROXY;
  const host = new URL(model.baseUrl).hostname;
  const local = /^(localhost|127\.|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  const dispatcher = proxy && !local ? new ProxyAgent(proxy) : undefined;
  let size = 0;
  const accept = event => {
    result.rawEvents.push(event);
    let answer = '', reasoning = '';
    if (event.error || event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.error?.message || event.response?.error?.message || event.message || 'Generation failed');
    }
    const choice = event.choices?.[0];
    if (choice) {
      answer = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
      reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.message?.reasoning_content ?? '';
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
    if (event.type === 'response.output_text.delta') answer = event.delta || '';
    if (/^response\.reasoning.*\.delta$/.test(event.type || '')) reasoning = event.delta || '';
    const response = event.response || (event.output ? event : null);
    if (response && ['completed', 'incomplete'].includes(response.status)) {
      if (!result.answer && !answer) answer = (response.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
      result.finishReason = response.incomplete_details?.reason || response.status;
      if (response.usage) result.usage = response.usage;
    }
    if (event.usage) result.usage = event.usage;
    if (typeof answer === 'string') result.answer += answer;
    if (typeof reasoning === 'string') result.reasoning += reasoning;
    if ((answer || reasoning) && result.ttftMs == null) result.ttftMs = Date.now() - started;
    onProgress({ ...result, answerChars: result.answer.length, reasoningChars: result.reasoning.length });
  };
  try {
    const res = await fetch(`${model.baseUrl.replace(/\/$/, '')}/${model.apiType === 'openai_responses' ? 'responses' : 'chat/completions'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}`, ...model.headers },
      body: JSON.stringify(generationBody(model, params, prompt)), dispatcher,
      signal: AbortSignal.any([signal, AbortSignal.timeout(params.timeoutSeconds * 1000)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      let text = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 8_000_000) throw new Error('Response exceeds 8 MB limit');
        text += decoder.decode(chunk, { stream: true });
      }
      accept(JSON.parse(text + decoder.decode()));
    } else {
      const decoder = new TextDecoder();
      let buffer = '';
      const processFrame = frame => {
        const data = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') accept(JSON.parse(data));
      };
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 8_000_000) throw new Error('Response exceeds 8 MB limit');
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          processFrame(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(buffer);
    }
    if (!result.finishReason) throw new Error('Stream ended without a completion marker');
  } catch (err) {
    result.error = String(err.message).split(model.apiKey).join('***');
  } finally {
    result.durationMs = Date.now() - started;
    if (dispatcher) await dispatcher.close();
  }
  return result;
}
