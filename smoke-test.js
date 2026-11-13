'use strict';
/**
 * FLASH AGENT — end-to-end smoke test.
 * Boots the real server against a throwaway database and exercises every
 * public and admin route, including a live OpenAI call.
 *
 *   node server/scripts/smoke-test.js
 */
process.env.PORT = process.env.SMOKE_PORT || '3999';
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || '/tmp/.scratch/smoke-data';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// fresh throwaway state
if (fs.existsSync(config.DB_FILE)) fs.rmSync(config.DB_FILE, { force: true });
for (const f of fs.existsSync(config.DATA_DIR) ? fs.readdirSync(config.DATA_DIR) : []) {
  if (f.startsWith('flash-agent.db')) fs.rmSync(path.join(config.DATA_DIR, f), { force: true });
}

require('../index'); // starts listening

const base = `http://127.0.0.1:${process.env.PORT}`;
let cookies = {};
const results = [];

function setCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] || []);
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v) cookies[k] = v; else delete cookies[k];
  }
}
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function call(method, url, body, { raw = false } = {}) {
  const headers = {};
  if (cookieHeader()) headers.Cookie = cookieHeader();
  let payload;
  if (body instanceof Blob || Buffer.isBuffer(body)) {
    payload = body;
    headers['Content-Type'] = 'audio/webm';
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
  setCookies(res);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { _text: text.slice(0, 200) }; }
  return { status: res.status, data };
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sse(url, body) {
  // Collect SSE frames from a streaming POST.
  return fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify(body),
  }).then(async (res) => {
    setCookies(res);
    const text = await res.text();
    const frames = text.split('\n\n').filter(Boolean).map((f) => {
      const ev = /event:\s*(.*)/.exec(f);
      const dt = /data:\s*([\s\S]*)/.exec(f);
      let parsed = null;
      try { parsed = dt ? JSON.parse(dt[1]) : null; } catch { /* noop */ }
      return { event: ev ? ev[1].trim() : 'message', data: parsed };
    });
    return { status: res.status, frames };
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 700));
  console.log('\n── FLASH AGENT smoke test ─────────────────────────────');

  /* health + config */
  let r = await call('GET', '/api/health');
  check('GET /api/health', r.status === 200 && r.data.database === 'connected', r.data.version);
  r = await call('GET', '/api/public/config');
  check('GET /api/public/config', r.status === 200 && r.data.app_name === 'FLASH AGENT', r.data.slogan);
  r = await call('GET', '/');
  check('GET / (public app served)', r.status === 200);
  r = await call('GET', '/admin');
  check('GET /admin (admin dashboard served)', r.status === 200);

  /* auth guard */
  r = await call('GET', '/api/conversations');
  check('Protected route rejects anonymous', r.status === 401, r.data.error);

  /* registration + login */
  r = await call('POST', '/api/auth/register', { username: 'tester', password: 'TestPass123' });
  check('POST /api/auth/register', r.status === 200 && r.data.user.username === 'tester');
  const userId = r.data.user && r.data.user.id;
  r = await call('GET', '/api/auth/me');
  check('GET /api/auth/me (session cookie)', r.status === 200 && r.data.user.username === 'tester');
  r = await call('POST', '/api/auth/login', { username: 'tester', password: 'wrong-password' });
  check('Login rejects a bad password', r.status === 401);
  r = await call('POST', '/api/auth/register', { username: 'tester', password: 'TestPass123' });
  check('Duplicate registration rejected', r.status === 409);

  /* conversations */
  r = await call('POST', '/api/conversations', { mode: 'chat' });
  const convId = r.data.conversation && r.data.conversation.id;
  check('POST /api/conversations', r.status === 200 && !!convId);
  r = await call('PATCH', `/api/conversations/${convId}`, { title: 'Smoke test chat' });
  check('PATCH /api/conversations/:id (rename)', r.status === 200 && r.data.conversation.title === 'Smoke test chat');

  /* chat: live OpenAI, expects the real provider answer or the real error */
  const chat = await sse('/api/chat', { message: 'Reply with exactly: FLASH ONLINE', conversationId: convId, mode: 'chat' });
  const done = chat.frames.find((f) => f.event === 'done');
  const err = chat.frames.find((f) => f.event === 'error');
  if (done) {
    check('POST /api/chat streams a live OpenAI answer', true, JSON.stringify((done.data.content || '').slice(0, 60)));
  } else if (err) {
    check('POST /api/chat streams a typed error (provider blocked)', ['insufficient_credits', 'invalid_api_key'].includes(err.data.code), `${err.data.code}: ${String(err.data.message).slice(0, 80)}`);
  } else {
    check('POST /api/chat streams a live OpenAI answer', false, 'no done/error frame');
  }

  /* regeneration */
  const regen = await sse('/api/chat/regenerate', { conversationId: convId });
  const regenErr = regen.frames.find((f) => f.event === 'error');
  const regenDone = regen.frames.find((f) => f.event === 'done');
  check('POST /api/chat/regenerate responds', regen.status === 200 && (!!regenDone || !!regenErr), regenErr ? regenErr.data.code : 'ok');

  r = await call('GET', `/api/conversations/${convId}`);
  check('GET /api/conversations/:id returns messages', r.status === 200 && Array.isArray(r.data.messages));

  /* AI status */
  r = await call('GET', '/api/ai/status');
  check('GET /api/ai/status', r.status === 200 && r.data.provider === 'OpenAI', `model ${r.data.model}`);

  /* memory */
  r = await call('POST', '/api/memories', { content: 'The user prefers Libyan Arabic and concise answers.' });
  const memId = r.data.memory && r.data.memory.id;
  check('POST /api/memories', r.status === 200 && !!memId);
  r = await call('GET', '/api/memories');
  check('GET /api/memories', r.status === 200 && r.data.memories.length === 1);
  r = await call('POST', '/api/memories/suggest', { conversationId: convId });
  check('POST /api/memories/suggest (live model or clean error)', r.status === 200 || r.status === 402, r.data.error || `${(r.data.suggestions || []).length} suggestions`);
  r = await call('DELETE', `/api/memories/${memId}`);
  check('DELETE /api/memories/:id', r.status === 200);

  /* voice */
  r = await call('POST', '/api/voice/speak', { text: 'اختبار الصوت', voice: 'alloy', speed: 1 });
  check('POST /api/voice/speak (TTS)', r.status === 200 || r.status === 402, r.status === 200 ? 'mp3 returned' : `blocked: ${r.data.error}`);
  r = await call('POST', '/api/voice/transcribe', Buffer.alloc(3000, 1));
  check('POST /api/voice/transcribe (STT)', [200, 400, 402].includes(r.status), `status ${r.status} ${r.data.error || ''}`);
  r = await call('GET', '/api/voice/voices');
  check('GET /api/voice/voices', r.status === 200 && r.data.voices.length > 3);

  /* vision: 1x1 png */
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const vis = await sse('/api/chat', { message: 'What is in this image?', images: [png], mode: 'vision' });
  const visDone = vis.frames.find((f) => f.event === 'done');
  const visErr = vis.frames.find((f) => f.event === 'error');
  check('POST /api/chat with image (Flash Vision)', !!visDone || (visErr && ['insufficient_credits', 'invalid_api_key'].includes(visErr.data.code)), visErr ? visErr.data.code : 'answered');

  /* admin auth */
  r = await call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' });
  check('Admin login rejects a bad password', r.status === 401);
  r = await call('POST', '/api/admin/login', { username: 'tester', password: 'TestPass123' });
  check('Non-admin cannot sign in to /admin', r.status === 401);

  const adminPw = process.env.ADMIN_INITIAL_PASSWORD || config.ADMIN_INITIAL_PASSWORD;
  r = await call('POST', '/api/admin/login', { username: 'admin', password: adminPw });
  check('Admin login with deployment password', r.status === 200 && r.data.admin.username === 'admin');
  check('First login forces a password change', !!(r.data.admin && r.data.admin.must_change_password));

  r = await call('GET', '/api/admin/overview');
  check('Admin route blocked until password changed', r.status === 403 && r.data.error === 'password_change_required');

  r = await call('POST', '/api/admin/change-password', { currentPassword: adminPw, newPassword: 'FlashAdmin2026!' });
  check('POST /api/admin/change-password', r.status === 200);

  r = await call('GET', '/api/admin/overview');
  check('GET /api/admin/overview', r.status === 200 && typeof r.data.stats.users === 'number', `${r.data.stats.users} users, model ${r.data.ai.model}`);
  check('Password is stored hashed (never returned)', !JSON.stringify(r.data).toLowerCase().includes('password_hash'));

  /* admin: providers + live connection test */
  r = await call('GET', '/api/admin/providers');
  const providerId = r.data.providers && r.data.providers[0] && r.data.providers[0].id;
  check('GET /api/admin/providers', r.status === 200 && !!providerId, `${r.data.providers.length} provider(s)`);
  check('API key is masked in responses', !JSON.stringify(r.data).includes('sk-proj-'), r.data.providers[0].api_key_masked);

  r = await call('POST', '/api/admin/test-connection', { id: providerId });
  check('POST /api/admin/test-connection (live OpenAI)', typeof r.data.ok === 'boolean', `${r.data.code || 'ok'} — ${String(r.data.message).slice(0, 90)}`);
  const connCode = r.data.code;

  r = await call('PATCH', `/api/admin/providers/${providerId}`, { temperature: 0.35, max_tokens: 1024, model: 'gpt-4o-mini' });
  check('PATCH provider (model + temperature + tokens)', r.status === 200 && r.data.provider.temperature === 0.35 && r.data.provider.max_tokens === 1024);

  r = await call('POST', `/api/admin/providers/${providerId}/activate`, {});
  check('POST provider activate', r.status === 200 && r.data.providers.some((p) => p.active));

  /* admin: settings + personality */
  r = await call('PUT', '/api/admin/settings', { ai_name: 'FLASH', arabic_dialect: 'libyan', response_length: 'balanced', daily_message_limit: 150 });
  check('PUT /api/admin/settings (personality)', r.status === 200 && String(r.data.settings.daily_message_limit) === '150');
  r = await call('PUT', '/api/admin/settings', { maintenance_mode: true });
  check('Maintenance mode toggles', r.status === 200 && r.data.settings.maintenance_mode === 'true');
  r = await call('PUT', '/api/admin/settings', { maintenance_mode: false });

  /* admin: users */
  r = await call('GET', '/api/admin/users?q=tester');
  check('GET /api/admin/users (search)', r.status === 200 && r.data.users.length === 1);
  r = await call('PATCH', `/api/admin/users/${userId}`, { status: 'suspended' });
  check('PATCH user → suspend', r.status === 200 && r.data.user.status === 'suspended');
  r = await call('PATCH', `/api/admin/users/${userId}`, { status: 'active' });
  check('PATCH user → activate', r.status === 200 && r.data.user.status === 'active');
  r = await call('POST', `/api/admin/users/${userId}/reset-password`, { password: 'ResetPass123' });
  check('POST user reset-password', r.status === 200);
  r = await call('POST', '/api/admin/users', { username: 'tempuser', password: 'TempPass123' });
  const tempId = r.data.user && r.data.user.id;
  check('POST /api/admin/users (create)', r.status === 200 && !!tempId);
  r = await call('DELETE', `/api/admin/users/${tempId}`);
  check('DELETE /api/admin/users/:id', r.status === 200);

  /* admin: analytics + audit */
  r = await call('GET', '/api/admin/analytics?days=7');
  check('GET /api/admin/analytics', r.status === 200 && Array.isArray(r.data.daily) && r.data.daily.length === 7);
  r = await call('GET', '/api/admin/audit');
  check('GET /api/admin/audit', r.status === 200 && r.data.entries.length > 0, `${r.data.entries.length} entries`);

  /* rate limiting header */
  const lim = await fetch(`${base}/api/voice/voices`, { headers: { Cookie: cookieHeader() } });
  check('Rate-limit headers present', lim.headers.has('x-ratelimit-limit'), lim.headers.get('x-ratelimit-limit'));

  /* unauthorised admin access */
  const savedCookies = cookies;
  cookies = {};
  r = await call('GET', '/api/admin/overview');
  check('Admin API locked without a session', r.status === 401);
  cookies = savedCookies;

  /* cleanup */
  await call('DELETE', `/api/conversations/${convId}`);

  const passed = results.filter((x) => x.ok).length;
  console.log('───────────────────────────────────────────────────────');
  console.log(`  ${passed}/${results.length} checks passed`);
  if (connCode) console.log(`  Live provider state: ${connCode}`);
  console.log('───────────────────────────────────────────────────────\n');

  fs.writeFileSync('/tmp/.scratch/smoke-result.json', JSON.stringify({ results, connCode, passed, total: results.length }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE FAILED', e); process.exit(2); });

