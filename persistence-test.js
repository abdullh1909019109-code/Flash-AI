'use strict';
/** FLASH AGENT — restart persistence + static asset check. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');
const DATA = '/tmp/.scratch/persist';
fs.rmSync(DATA, { recursive: true, force: true });

function start(port) {
  const p = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: DATA, ENV_FILE: path.join(ROOT, '.env') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function call(port, method, url, body) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) { const pair = c.split(';')[0]; if (!pair.endsWith('=')) cookie = pair; }
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  let srv = start(4100);
  await wait(2200);
  console.log('── boot 1 ──');
  let r = await call(4100, 'POST', '/api/auth/register', { username: 'persistuser', password: 'Persist123' });
  console.log('register:', r.status, r.data.user && r.data.user.username);
  r = await call(4100, 'POST', '/api/conversations', { mode: 'chat' });
  const convId = r.data.conversation.id;
  console.log('conversation created:', convId);
  srv.kill('SIGTERM');
  await wait(1200);

  srv = start(4100);
  await wait(2200);
  console.log('── boot 2 (fresh process, same data dir) ──');
  r = await call(4100, 'GET', '/api/auth/me');
  console.log('session restored:', r.status, r.data.user && r.data.user.username);
  r = await call(4100, 'GET', '/api/conversations');
  console.log('conversations after restart:', r.data.conversations && r.data.conversations.length, '→ id', r.data.conversations?.[0]?.id);
  r = await call(4100, 'POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PW || 'Abdullh2009Za@#$' });
  console.log('admin still present after restart:', r.status);
  srv.kill('SIGTERM');
  await wait(900);

  srv = start(4101);
  await wait(2200);
  console.log('── static assets ──');
  const urls = ['/', '/admin', '/css/app.css', '/css/admin.css', '/js/app.js', '/js/admin.js',
    '/js/markdown.js', '/assets/logo.svg', '/assets/favicon.svg', '/manifest.webmanifest',
    '/sw.js', '/api/health'];
  let bad = 0;
  for (const u of urls) {
    const res = await fetch(`http://127.0.0.1:4101${u}`);
    const ok = res.status === 200;
    if (!ok) bad++;
    console.log(`${ok ? '  ✓' : '  ✗'} ${res.status}  ${u}  (${res.headers.get('content-type') || ''})`);
  }
  srv.kill('SIGTERM');
  console.log(bad ? `\n${bad} asset(s) failed` : '\nall assets served');
  process.exit(bad ? 1 : 0);
})();

