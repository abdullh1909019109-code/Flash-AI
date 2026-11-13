'use strict';
/**
 * FLASH AGENT — HTTP server.
 * Public app at /, independent admin dashboard at /admin, API at /api.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { attachUser, requireUser } = require('./auth');
const { getSettings, db } = require('./db');
const { apiLimiter } = require('./rateLimit');
const { seed } = require('./seed');

seed();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ───────────────────────── security headers ───────────────────────── */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/* ───────────────────────── bodies ───────────────────────── */

app.use('/api/voice/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '26mb' }));
app.use(express.json({ limit: '40mb' })); // image data URLs travel as JSON
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(attachUser);

/* ───────────────────────── static ───────────────────────── */

app.use('/uploads', express.static(config.UPLOAD_DIR, { maxAge: '7d', index: false }));
app.use(express.static(path.join(config.ROOT, 'public'), { extensions: ['html'], maxAge: config.IS_PROD ? '1h' : 0 }));

/* ───────────────────────── api ───────────────────────── */

app.get('/api/health', (_req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({
    ok: dbOk,
    app: 'FLASH AGENT',
    version: config.VERSION,
    time: new Date().toISOString(),
    database: dbOk ? 'connected' : 'error',
  });
});

app.get('/api/public/config', (_req, res) => {
  const s = getSettings();
  res.json({
    app_name: s.app_name, slogan: s.slogan, logo_url: s.logo_url, theme: s.theme,
    ai_name: s.ai_name, registration_enabled: s.registration_enabled === 'true',
    maintenance_mode: s.maintenance_mode === 'true',
    maintenance_message: s.maintenance_message,
    default_language: s.default_language, arabic_dialect: s.arabic_dialect,
    tts_voice: s.tts_voice, tts_speed: s.tts_speed,
    vision_model: s.vision_model, version: config.VERSION,
  });
});

app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api', require('./routes/chat.routes'));
app.use('/api/voice', require('./routes/voice.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

/* ───────────────────────── maintenance mode ───────────────────────── */

app.use((req, res, next) => {
  const s = getSettings();
  if (s.maintenance_mode !== 'true') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  if (req.user && req.user.role === 'admin') return next();
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${s.app_name} — Maintenance</title>
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05060d;color:#e8ecff;
    font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:24px}
    h1{font-size:28px;letter-spacing:.18em;margin:0 0 12px;background:linear-gradient(90deg,#4d8dff,#a06bff);
    -webkit-background-clip:text;background-clip:text;color:transparent}
    p{color:#9aa6c6;max-width:46ch;line-height:1.6}</style></head>
    <body><div><h1>${s.app_name}</h1><p>${s.maintenance_message}</p></div></body></html>`);
});

/* ───────────────────────── app entry points ───────────────────────── */

app.get('/admin', (_req, res) => res.sendFile(path.join(config.ROOT, 'public', 'admin.html')));
app.get('/admin/*', (req, res, next) => {
  if (req.path.includes('.')) return next();
  res.sendFile(path.join(config.ROOT, 'public', 'admin.html'));
});
app.get('/', (_req, res) => res.sendFile(path.join(config.ROOT, 'public', 'index.html')));

/* ───────────────────────── errors ───────────────────────── */

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not_found', message: 'Unknown API endpoint.' });
  res.status(404).sendFile(path.join(config.ROOT, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.code ? 502 : 500);
  if (status >= 500) console.error('[error]', err.code || '', err.message);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: err.code || 'server_error',
    message: err.message || 'Something went wrong on the server.',
    hint: err.hint || '',
  });
});

const server = app.listen(config.PORT, () => {
  console.log(`\n  ⚡ FLASH AGENT ${config.VERSION}`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  Public app : http://localhost:${config.PORT}/`);
  console.log(`  Admin      : http://localhost:${config.PORT}/admin`);
  console.log(`  API        : http://localhost:${config.PORT}/api/health`);
  console.log(`  Database   : ${config.DB_FILE}`);
  console.log(`  ────────────────────────────────────────────\n`);
});

function shutdown(sig) {
  console.log(`[${sig}] shutting down…`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;

