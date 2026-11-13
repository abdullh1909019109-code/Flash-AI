'use strict';
/**
 * FLASH AGENT — AI engine.
 * One OpenAI-compatible code path drives every provider (OpenAI, Gemini's
 * OpenAI-compat endpoint, xAI, custom). Keys are decrypted server-side only.
 * Every call is metered into usage_log with an estimated USD cost.
 */
const { db, getSettings, getActiveProvider, numSetting } = require('./db');

/* ───────────────────────── personality ───────────────────────── */

const DIALECTS = {
  libyan: 'Libyan Arabic (اللهجة الليبية) — natural everyday Tripoli/Benghazi speech, not Modern Standard Arabic',
  egyptian: 'Egyptian Arabic (اللهجة المصرية)',
  gulf: 'Gulf Arabic (اللهجة الخليجية)',
  levantine: 'Levantine Arabic (اللهجة الشامية)',
  msa: 'Modern Standard Arabic (الفصحى)',
  none: '',
};

const MODES = {
  chat: '',
  code:
    'You are in FLASH CODE mode: act as a senior software engineer. Produce complete, runnable code in fenced ' +
    'blocks with the correct language tag, then a short explanation of how it works, edge cases and how to run it. ' +
    'When debugging, state the root cause first, then the fix. Never invent APIs.',
  vision:
    'You are in FLASH VISION mode: analyse the attached image(s) precisely. Describe only what is visible, ' +
    'quote any text you can read, and clearly separate observation from inference.',
  translate:
    'You are in FLASH TRANSLATE mode: translate faithfully, preserve tone and formatting, give the translation ' +
    'first and a short note on tricky wording only when needed.',
};

function buildSystemPrompt({ settings, memories = [], mode = 'chat', user }) {
  const s = settings || getSettings();
  const parts = [];

  parts.push(s.system_prompt || 'You are FLASH, the AI core of the FLASH AGENT platform.');

  if (s.personality) parts.push(`Personality: ${s.personality}.`);
  if (s.ai_name && s.ai_name !== 'FLASH') parts.push(`Your name is ${s.ai_name}; users address you by it.`);

  const len = { short: 'Keep answers tight: 1-3 short paragraphs unless asked for more.',
                balanced: 'Aim for a clear, well-structured answer with no filler.',
                detailed: 'Give thorough, structured answers with examples and headings where useful.' }[s.response_length];
  if (len) parts.push(len);

  const style = { precise: 'Prefer exact, verifiable statements; avoid flourish.',
                  balanced: 'Be warm but efficient.',
                  creative: 'Be imaginative and expressive while staying accurate.' }[s.creativity];
  if (style) parts.push(style);

  // Language policy
  if (s.default_language === 'ar') {
    parts.push('Reply in Arabic by default. If the user writes in English, reply in English.');
  } else if (s.default_language === 'en') {
    parts.push('Reply in English by default. If the user writes in Arabic, reply in Arabic.');
  } else {
    parts.push('Always reply in the language the user wrote in.');
  }
  const dialect = DIALECTS[s.arabic_dialect] || '';
  if (dialect) parts.push(`When replying in Arabic, use ${dialect}, unless the user asks for another variety.`);
  parts.push('If the user mixes dialects or asks to "talk Libyan", switch to that dialect naturally.');

  parts.push('Format with markdown. Use fenced code blocks with a language tag for any code. Never fabricate facts,');
  parts.push('citations, or API results; if you do not know, say so plainly.');

  if (MODES[mode]) parts.push(MODES[mode]);

  if (memories.length) {
    parts.push('Long-term memories about this user (use them naturally, never list them back):');
    for (const m of memories.slice(0, 12)) parts.push(`- ${m.content}`);
  }
  if (user && user.username) parts.push(`The user's name is ${user.username}.`);

  return parts.filter(Boolean).join('\n');
}

/* ───────────────────────── errors ───────────────────────── */

class EngineError extends Error {
  constructor(code, message, status = 502, hint = '') {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function mapUpstreamError(status, bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { /* not json */ }
  const err = (parsed && parsed.error) || {};
  const code = err.code || err.status || '';
  const msg = err.message || (typeof bodyText === 'string' ? bodyText.slice(0, 300) : 'Upstream error');

  if (code === 'insufficient_quota' || /credit_balance_exhausted|no credits remaining|exceeded your current quota/i.test(msg)) {
    return new EngineError('insufficient_credits',
      'The AI provider account has no credits remaining, so no response can be generated.',
      402,
      'Add credits to the provider account, or set a different API key in the admin dashboard → AI Configuration.');
  }
  if (status === 401 || code === 'invalid_api_key') {
    return new EngineError('invalid_api_key',
      'The AI provider rejected the API key.', 401,
      'Update the API key in the admin dashboard → AI Configuration, then run “Test connection”.');
  }
  if (status === 429) {
    return new EngineError('provider_rate_limited',
      'The AI provider is rate limiting requests right now.', 429, 'Wait a few seconds and try again.');
  }
  if (status === 404) {
    return new EngineError('model_not_found',
      `The provider does not expose that model or endpoint (${msg}).`, 404,
      'Check the model name and API base URL in the admin dashboard → AI Configuration.');
  }
  if (status === 400) {
    return new EngineError('bad_request', msg, 400, 'Check the model, token limit and message content.');
  }
  return new EngineError('provider_error', msg || `Provider returned HTTP ${status}`, 502,
    'Try again, or check the provider status page.');
}

function networkError(e) {
  const cause = (e && e.cause && (e.cause.code || e.cause.message)) || e.message || 'network failure';
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(String(cause))) {
    return new EngineError('network_error', 'Could not reach the AI provider (DNS lookup failed).', 503,
      'Check the API base URL and the server’s internet connection.');
  }
  if (/ECONNREFUSED/i.test(String(cause))) {
    return new EngineError('network_error', 'The AI provider refused the connection.', 503,
      'Check the API base URL in the admin dashboard.');
  }
  if (/aborted|AbortError/i.test(String(cause))) {
    return new EngineError('aborted', 'Generation stopped.', 499);
  }
  return new EngineError('network_error', `Network failure while contacting the AI provider (${cause}).`, 503,
    'Check the server’s internet connection and try again.');
}

/* ───────────────────────── provider resolution ───────────────────────── */

function resolveProvider() {
  const provider = getActiveProvider({ withSecrets: true });
  const settings = getSettings();
  const p = provider || {
    id: null, name: 'OpenAI', kind: 'openai',
    base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    api_key: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.7, max_tokens: 2048,
  };
  // Env key is the fallback when the DB row has no key stored yet.
  if (!p.api_key) p.api_key = process.env.OPENAI_API_KEY || '';
  return { provider: p, settings };
}

function assertUsable(p) {
  if (!p) throw new EngineError('no_provider', 'No AI provider is configured.', 503, 'Configure one in the admin dashboard → AI Configuration.');
  if (!p.api_key) throw new EngineError('no_api_key', 'No API key is configured for the active AI provider.', 503, 'Add the API key in the admin dashboard → AI Configuration.');
  if (!p.base_url) throw new EngineError('no_base_url', 'The active AI provider has no API base URL.', 503, 'Set it in the admin dashboard → AI Configuration.');
}

/* ───────────────────────── cost ───────────────────────── */

function estimateCost(promptTokens, completionTokens, settings) {
  const inRate = parseFloat(settings.price_in_per_mtok ?? numSetting('price_in_per_mtok', 0.15)) || 0;
  const outRate = parseFloat(settings.price_out_per_mtok ?? numSetting('price_out_per_mtok', 0.6)) || 0;
  return (promptTokens / 1e6) * inRate + (completionTokens / 1e6) * outRate;
}

function logUsage(entry) {
  try {
    db.prepare(`INSERT INTO usage_log
      (user_id, conversation_id, provider_id, provider, model, kind,
       prompt_tokens, completion_tokens, total_tokens, cost_usd, status, error, ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      entry.userId || null, entry.conversationId || null, entry.providerId || null,
      entry.provider || null, entry.model || null, entry.kind || 'chat',
      entry.promptTokens || 0, entry.completionTokens || 0,
      (entry.promptTokens || 0) + (entry.completionTokens || 0),
      entry.cost || 0, entry.status || 'ok', entry.error || null, entry.ms || 0
    );
  } catch (e) { console.error('[usage]', e.message); }
}

/* ───────────────────────── requests ───────────────────────── */

function authHeaders(p) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.api_key}`,
  };
}

/**
 * Non-streaming chat completion. Returns { text, promptTokens, completionTokens, model }.
 * @param {{messages:Array, mode?:string, memories?:Array, user?:object, overrideModel?:string,
 *          temperature?:number, maxTokens?:number, provider?:object, settings?:object,
 *          kind?:string, userId?:number, conversationId?:number}} opts
 */
async function complete(opts) {
  const { provider, settings } = opts.provider ? { provider: opts.provider, settings: opts.settings || getSettings() } : resolveProvider();
  assertUsable(provider);

  const model = opts.overrideModel || provider.model;
  const temperature = opts.temperature ?? provider.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? provider.max_tokens ?? 2048;

  const messages = [
    { role: 'system', content: buildSystemPrompt({ settings, memories: opts.memories, mode: opts.mode, user: opts.user }) },
    ...opts.messages,
  ];

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: opts.signal,
    });
  } catch (e) {
    const err = networkError(e);
    logUsage({ ...opts, provider: provider.name, model, status: 'error', error: err.code, ms: Date.now() - started });
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = mapUpstreamError(res.status, text);
    logUsage({ ...opts, provider: provider.name, model, status: 'error', error: err.code, ms: Date.now() - started });
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  const promptTokens = data?.usage?.prompt_tokens || 0;
  const completionTokens = data?.usage?.completion_tokens || 0;
  const cost = estimateCost(promptTokens, completionTokens, settings);

  logUsage({
    ...opts, provider: provider.name, model: data.model || model,
    promptTokens, completionTokens, cost, status: 'ok', ms: Date.now() - started,
  });

  return { text, promptTokens, completionTokens, cost, model: data.model || model, finishReason: data?.choices?.[0]?.finish_reason };
}

/**
 * Streaming chat completion. Calls onDelta(text) per token chunk.
 * Resolves with the full text + usage. Aborts cleanly via opts.signal.
 */
async function stream(opts, onDelta) {
  const { provider, settings } = opts.provider ? { provider: opts.provider, settings: opts.settings || getSettings() } : resolveProvider();
  assertUsable(provider);

  const model = opts.overrideModel || provider.model;
  const temperature = opts.temperature ?? provider.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? provider.max_tokens ?? 2048;

  const messages = [
    { role: 'system', content: buildSystemPrompt({ settings, memories: opts.memories, mode: opts.mode, user: opts.user }) },
    ...opts.messages,
  ];

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify({
        model, messages, temperature, max_tokens: maxTokens,
        stream: true, stream_options: { include_usage: true },
      }),
      signal: opts.signal,
    });
  } catch (e) {
    const err = networkError(e);
    logUsage({ ...opts, provider: provider.name, model, status: 'error', error: err.code, ms: Date.now() - started });
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = mapUpstreamError(res.status, text);
    logUsage({ ...opts, provider: provider.name, model, status: 'error', error: err.code, ms: Date.now() - started });
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let aborted = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens || promptTokens;
          completionTokens = json.usage.completion_tokens || completionTokens;
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      }
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
      aborted = true;
    } else {
      const err = networkError(e);
      logUsage({ ...opts, provider: provider.name, model, status: 'error', error: err.code, ms: Date.now() - started,
        promptTokens, completionTokens });
      throw err;
    }
  }

  const cost = estimateCost(promptTokens, completionTokens, settings);
  logUsage({
    ...opts, provider: provider.name, model, promptTokens, completionTokens, cost,
    status: aborted ? 'stopped' : 'ok', ms: Date.now() - started,
  });

  return { text: full, promptTokens, completionTokens, cost, model, aborted };
}

/* ───────────────────────── vision ───────────────────────── */

function imagePart(dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } };
}

async function vision({ dataUrls, prompt, user, memories, mode = 'vision', settings, provider: pOverride, userId, conversationId }) {
  const { provider, settings: s } = pOverride ? { provider: pOverride, settings: settings || getSettings() } : resolveProvider();
  assertUsable(provider);
  const visionModel = s.vision_model || provider.model;
  const content = [...dataUrls.map(imagePart), { type: 'text', text: prompt }];
  return complete({
    messages: [{ role: 'user', content }],
    mode, user, memories, settings: s, provider,
    overrideModel: visionModel, userId, conversationId, kind: 'vision',
  });
}

/* ───────────────────────── voice ───────────────────────── */

async function transcribe({ buffer, mime, filename, language, userId, conversationId }) {
  const { provider, settings } = resolveProvider();
  assertUsable(provider);
  const model = settings.stt_model || 'whisper-1';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), filename || 'audio.webm');
  form.append('model', model);
  if (language && language !== 'auto') form.append('language', language);

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${provider.base_url}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.api_key}` },
      body: form,
    });
  } catch (e) {
    const err = networkError(e);
    logUsage({ provider: provider.name, model, kind: 'stt', status: 'error', error: err.code, userId, conversationId, ms: Date.now() - started });
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = mapUpstreamError(res.status, text);
    logUsage({ provider: provider.name, model, kind: 'stt', status: 'error', error: err.code, userId, conversationId, ms: Date.now() - started });
    throw err;
  }
  const data = await res.json();
  logUsage({ provider: provider.name, model, kind: 'stt', status: 'ok', userId, conversationId, ms: Date.now() - started });
  return { text: data.text || '', language: data.language || language || null };
}

async function speak({ text, voice, speed, userId }) {
  const { provider, settings } = resolveProvider();
  assertUsable(provider);
  const model = 'gpt-4o-mini-tts';
  const started = Date.now();

  let res;
  try {
    res = await fetch(`${provider.base_url}/audio/speech`, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify({
        model,
        voice: voice || settings.tts_voice || 'alloy',
        input: String(text).slice(0, 4000),
        speed: Math.min(2, Math.max(0.5, parseFloat(speed || settings.tts_speed || 1))),
        response_format: 'mp3',
      }),
    });
  } catch (e) {
    const err = networkError(e);
    logUsage({ provider: provider.name, model, kind: 'tts', status: 'error', error: err.code, userId, ms: Date.now() - started });
    throw err;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = mapUpstreamError(res.status, t);
    logUsage({ provider: provider.name, model, kind: 'tts', status: 'error', error: err.code, userId, ms: Date.now() - started });
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  logUsage({ provider: provider.name, model, kind: 'tts', status: 'ok', userId, ms: Date.now() - started });
  return buf;
}

/* ───────────────────────── connection test ───────────────────────── */

async function testConnection(providerLike) {
  const p = providerLike || resolveProvider().provider;
  const started = Date.now();
  if (!p) return { ok: false, code: 'no_provider', message: 'No provider configured.' };
  if (!p.api_key) return { ok: false, code: 'no_api_key', message: 'No API key configured for this provider.' };
  if (!p.base_url) return { ok: false, code: 'no_base_url', message: 'No API base URL configured.' };

  try {
    const res = await fetch(`${p.base_url}/models`, {
      headers: { Authorization: `Bearer ${p.api_key}` },
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - started;
    if (res.status === 401) {
      return { ok: false, code: 'invalid_api_key', message: 'The API key was rejected by the provider (HTTP 401).', ms };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const mapped = mapUpstreamError(res.status, t);
      return { ok: false, code: mapped.code, message: mapped.message, hint: mapped.hint, ms };
    }
    let models = [];
    try {
      const data = await res.json();
      models = (data.data || []).map((m) => m.id).filter(Boolean).slice(0, 300);
    } catch { /* some providers return nothing useful */ }

    // Auth works. Now check whether *completion* works, which is where
    // "no credits remaining" actually shows up.
    let completion = { ok: true, checked: false };
    try {
      const cRes = await fetch(`${p.base_url}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(p),
        body: JSON.stringify({
          model: p.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (cRes.ok) {
        completion = { ok: true, checked: true };
      } else {
        const t = await cRes.text().catch(() => '');
        const mapped = mapUpstreamError(cRes.status, t);
        completion = { ok: false, checked: true, code: mapped.code, message: mapped.message, hint: mapped.hint };
      }
    } catch (e) {
      completion = { ok: false, checked: true, code: 'network_error', message: networkError(e).message };
    }

    if (!completion.ok) {
      return {
        ok: false,
        code: completion.code,
        message: `Authentication succeeded, but generation does not work: ${completion.message}`,
        hint: completion.hint,
        models: models.slice(0, 60),
        ms,
      };
    }

    return {
      ok: true,
      message: 'Connection verified — authentication and generation both work.',
      model: p.model,
      models: models.slice(0, 60),
      ms,
    };
  } catch (e) {
    const err = networkError(e);
    return { ok: false, code: err.code, message: err.message, hint: err.hint, ms: Date.now() - started };
  }
}

/* ───────────────────────── memory extraction ───────────────────────── */

async function extractMemories({ messages, user, settings }) {
  const transcript = messages.slice(-12)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[image]'}`)
    .join('\n')
    .slice(0, 6000);

  const { text } = await complete({
    messages: [
      { role: 'system', content: 'Extract durable facts about the user worth remembering long-term (preferences, name, ' +
        'role, ongoing projects, constraints). Return ONLY a JSON array of short strings, max 4 items. ' +
        'Return [] if nothing is worth saving. Never include secrets, passwords, API keys or payment data.' },
      { role: 'user', content: transcript },
    ],
    settings, user, mode: 'chat', maxTokens: 300, temperature: 0.2, kind: 'chat',
  });

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr)
      ? arr.filter((s) => typeof s === 'string' && s.trim().length > 3 && s.length < 300).slice(0, 4)
      : [];
  } catch { return []; }
}

module.exports = {
  complete, stream, vision, transcribe, speak, testConnection, extractMemories,
  buildSystemPrompt, resolveProvider, estimateCost, EngineError, mapUpstreamError,
  DIALECTS, MODES,
};

