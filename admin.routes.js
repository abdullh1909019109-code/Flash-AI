'use strict';
/**
 * FLASH AGENT — independent admin API (mounted at /api/admin).
 * Every route below requireAdmin except login/session/logout.
 */
const express = require('express');
const os = require('os');
const { db, getSettings, setSettings, getSetting, listProviders, getActiveProvider,
        encryptSecret, PROVIDER_PRESETS, audit } = require('../db');
const { verifyPassword, createUser, changePassword, validatePassword, createSession, destroySession, requireAdmin, requireUser } = require('../auth');
const { loginLimiter } = require('../rateLimit');
const engine = require('../engine');
const config = require('../config');

const router = express.Router();

/* ───────────────────────── auth ───────────────────────── */

router.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND role = ?').get(username, username.toLowerCase(), 'admin');
  if (!row || !verifyPassword(password, row.password_hash)) {
    audit(null, username, 'admin.login_failed', null, req.ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect administrator credentials.' });
  }
  if (row.status !== 'active') {
    return res.status(403).json({ error: 'suspended', message: 'This administrator account is suspended.' });
  }
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  createSession(row.id, 'admin', req, res);
  audit(row.id, row.username, 'admin.login', null, req.ip);
  res.json({
    admin: { id: row.id, username: row.username, must_change_password: !!row.must_change_password },
  });
});

router.post('/logout', (req, res) => {
  destroySession(req, res, 'admin');
  destroySession(req, res, 'app');
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.json({ admin: null });
  res.json({
    admin: {
      id: req.user.id, username: req.user.username,
      must_change_password: !!req.user.must_change_password,
    },
  });
});

router.post('/change-password', requireUser, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Admins only.' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(req.body.currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Current password is incorrect.' });
  }
  const err = validatePassword(req.body.newPassword);
  if (err) return res.status(400).json({ error: 'invalid_password', message: err });
  changePassword(req.user.id, req.body.newPassword);
  createSession(req.user.id, 'admin', req, res);
  audit(req.user.id, req.user.username, 'admin.password_changed', null, req.ip);
  res.json({ ok: true });
});

/* everything below needs an admin session */
router.use(requireAdmin);

/* ───────────────────────── overview ───────────────────────── */

router.get('/overview', async (req, res) => {
  const one = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] : 0; };
  const stats = {
    users: one('SELECT COUNT(*) FROM users'),
    admins: one("SELECT COUNT(*) FROM users WHERE role = 'admin'"),
    suspended: one("SELECT COUNT(*) FROM users WHERE status = 'suspended'"),
    conversations: one('SELECT COUNT(*) FROM conversations'),
    messages: one('SELECT COUNT(*) FROM messages'),
    user_messages: one("SELECT COUNT(*) FROM messages WHERE role = 'user'"),
    memories: one('SELECT COUNT(*) FROM memories'),
    today_requests: one("SELECT COUNT(*) FROM usage_log WHERE date(created_at) = date('now')"),
    today_tokens: one("SELECT COALESCE(SUM(total_tokens),0) FROM usage_log WHERE date(created_at) = date('now')"),
    today_cost: one("SELECT COALESCE(SUM(cost_usd),0) FROM usage_log WHERE date(created_at) = date('now')"),
    month_tokens: one("SELECT COALESCE(SUM(total_tokens),0) FROM usage_log WHERE created_at >= datetime('now','-30 day')"),
    month_cost: one("SELECT COALESCE(SUM(cost_usd),0) FROM usage_log WHERE created_at >= datetime('now','-30 day')"),
    errors_24h: one("SELECT COUNT(*) FROM usage_log WHERE status = 'error' AND created_at >= datetime('now','-1 day')"),
    active_users_7d: one("SELECT COUNT(DISTINCT user_id) FROM usage_log WHERE created_at >= datetime('now','-7 day')"),
  };
  const { provider } = engine.resolveProvider();
  const s = getSettings();
  const settingsObj = { ...s };
  delete settingsObj.openai_api_key;

  res.json({
    stats,
    ai: {
      provider: provider ? provider.name : null,
      model: provider ? provider.model : null,
      base_url: provider ? provider.base_url : null,
      has_key: !!(provider && provider.api_key),
      key_masked: provider ? (provider.api_key_masked || '') : '',
      configured: !!(provider && provider.api_key),
      model_active: provider ? provider.model : null,
    },
    settings: settingsObj,
    server: {
      version: config.VERSION,
      uptime_seconds: Math.round(process.uptime()),
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      db_size_kb: Math.round((require('fs').statSync(config.DB_FILE).size || 0) / 1024),
      platform: `${os.platform()} ${os.arch()}`,
    },
  });
});

/* ───────────────────────── AI configuration ───────────────────────── */

router.get('/providers', (_req, res) => {
  res.json({ providers: listProviders(), presets: PROVIDER_PRESETS });
});

/** Create a provider (or update the active one with same kind+base_url). */
router.post('/providers', (req, res) => {
  const b = req.body || {};
  const kind = ['openai', 'gemini', 'xai', 'custom'].includes(b.kind) ? b.kind : 'custom';
  const name = String(b.name || PROVIDER_PRESETS[kind].name).slice(0, 80);
  const baseUrl = String(b.base_url || PROVIDER_PRESETS[kind].base_url).replace(/\/+$/, '');
  const model = String(b.model || PROVIDER_PRESETS[kind].models[0]);
  const models = Array.isArray(b.models) && b.models.length ? JSON.stringify(b.models) : JSON.stringify(PROVIDER_PRESETS[kind].models);
  const temperature = Math.min(2, Math.max(0, parseFloat(b.temperature ?? 0.7)));
  const maxTokens = Math.min(32768, Math.max(64, parseInt(b.max_tokens ?? 2048, 10)));
  const keyEnc = b.api_key ? encryptSecret(String(b.api_key).trim()) : null;

  const info = db.prepare(`INSERT INTO providers (name, kind, base_url, api_key_enc, model, models, temperature, max_tokens, vision, active, enabled)
    VALUES (?,?,?,?,?,?,?,?,?,0,1)`).run(name, kind, baseUrl, keyEnc, model, models, temperature, maxTokens, b.vision === false ? 0 : 1);
  audit(req.user.id, req.user.username, 'admin.provider_created', { id: info.lastInsertRowid, name, kind }, req.ip);
  res.json({ provider: listProviders().find((p) => p.id === Number(info.lastInsertRowid)) });
});

router.patch('/providers/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  const b = req.body || {};
  const fields = [];
  const vals = [];
  const push = (sql, v) => { fields.push(sql); vals.push(v); };

  if (b.name !== undefined) push('name = ?', String(b.name).slice(0, 80));
  if (b.base_url !== undefined) push('base_url = ?', String(b.base_url).replace(/\/+$/, ''));
  if (b.model !== undefined) push('model = ?', String(b.model));
  if (b.models !== undefined) push('models = ?', JSON.stringify(b.models));
  if (b.temperature !== undefined) push('temperature = ?', Math.min(2, Math.max(0, parseFloat(b.temperature) || 0)));
  if (b.max_tokens !== undefined) push('max_tokens = ?', Math.min(32768, Math.max(64, parseInt(b.max_tokens, 10) || 2048)));
  if (b.vision !== undefined) push('vision = ?', b.vision ? 1 : 0);
  if (b.enabled !== undefined) push('enabled = ?', b.enabled ? 1 : 0);
  if (b.api_key !== undefined && String(b.api_key).trim()) push('api_key_enc = ?', encryptSecret(String(b.api_key).trim()));
  if (b.clear_key) push('api_key_enc = ?', null);

  if (!fields.length) return res.json({ provider: listProviders().find((x) => x.id === p.id) });
  push("updated_at = datetime('now')", undefined);
  vals.pop();
  db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...vals, p.id);
  audit(req.user.id, req.user.username, 'admin.provider_updated', { id: p.id }, req.ip);
  res.json({ provider: listProviders().find((x) => x.id === p.id) });
});

router.post('/providers/:id/activate', (req, res) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  db.prepare('UPDATE providers SET active = 0').run();
  db.prepare('UPDATE providers SET active = 1, enabled = 1, updated_at = datetime(\'now\') WHERE id = ?').run(p.id);
  audit(req.user.id, req.user.username, 'admin.provider_activated', { id: p.id, name: p.name }, req.ip);
  res.json({ ok: true, providers: listProviders() });
});

router.delete('/providers/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found', message: 'Provider not found.' });
  db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
  audit(req.user.id, req.user.username, 'admin.provider_deleted', { id: p.id, name: p.name }, req.ip);
  res.json({ ok: true, providers: listProviders() });
});

/**
 * Test a connection. Body may carry unsaved config {base_url, api_key, model, id};
 * when api_key is omitted and id is given, the stored key is used.
 */
router.post('/test-connection', async (req, res, next) => {
  try {
    const b = req.body || {};
    let apiKey = b.api_key ? String(b.api_key).trim() : '';
    let baseUrl = b.base_url ? String(b.base_url).replace(/\/+$/, '') : '';
    let model = b.model || '';

    if ((!apiKey || !baseUrl) && b.id) {
      const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(b.id);
      if (row) {
        const stored = require('../db').decryptSecret(row.api_key_enc);
        apiKey = apiKey || stored;
        baseUrl = baseUrl || row.base_url;
        model = model || row.model;
      }
    }
    if (!apiKey) {
      const env = engine.resolveProvider().provider;
      apiKey = env.api_key; baseUrl = baseUrl || env.base_url; model = model || env.model;
    }
    const result = await engine.testConnection({ name: b.name || 'Provider', base_url: baseUrl, api_key: apiKey, model });
    audit(req.user.id, req.user.username, 'admin.connection_test', { ok: result.ok, code: result.code || null }, req.ip);
    res.json(result);
  } catch (e) { next(e); }
});

/* ───────────────────────── settings + personality ───────────────────────── */

const EDITABLE = new Set([
  'app_name', 'slogan', 'logo_url', 'theme', 'accent',
  'registration_enabled', 'maintenance_mode', 'maintenance_message',
  'ai_name', 'personality', 'system_prompt', 'default_language', 'arabic_dialect',
  'creativity', 'response_length', 'daily_message_limit', 'rate_limit_per_minute',
  'max_input_chars', 'price_in_per_mtok', 'price_out_per_mtok',
  'tts_voice', 'tts_speed', 'stt_model', 'vision_model',
]);

router.get('/settings', (_req, res) => res.json({ settings: getSettings() }));

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    if (typeof v === 'object') continue;
    patch[k] = typeof v === 'boolean' ? String(v) : String(v);
  }
  if (typeof body.maintenance_mode === 'boolean') patch.maintenance_mode = body.maintenance_mode ? 'true' : 'false';
  if (typeof body.registration_enabled === 'boolean') patch.registration_enabled = body.registration_enabled ? 'true' : 'false';
  setSettings(patch);
  audit(req.user.id, req.user.username, 'admin.settings_updated', { keys: Object.keys(patch) }, req.ip);
  res.json({ settings: getSettings() });
});

/* ───────────────────────── users ───────────────────────── */

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversations,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages,
      (SELECT COUNT(*) FROM memories m WHERE m.user_id = u.id) AS memories
    FROM users u
    WHERE (? = '' OR u.username LIKE ? OR u.email LIKE ?)
    ORDER BY u.created_at DESC LIMIT 200`).all(q, like, like);
  res.json({ users: rows });
});

router.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  const b = req.body || {};
  if (b.status && ['active', 'suspended'].includes(b.status)) {
    if (u.id === req.user.id && b.status === 'suspended') {
      return res.status(400).json({ error: 'self', message: 'You cannot suspend your own account.' });
    }
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(b.status, u.id);
    if (b.status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(req.user.id, req.user.username, 'admin.user_status', { id: u.id, status: b.status }, req.ip);
  }
  if (b.role && ['user', 'admin'].includes(b.role)) {
    if (u.id === req.user.id && b.role !== 'admin') {
      return res.status(400).json({ error: 'self', message: 'You cannot remove your own admin role.' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
    audit(req.user.id, req.user.username, 'admin.user_role', { id: u.id, role: b.role }, req.ip);
  }
  res.json({ user: db.prepare('SELECT id, username, email, role, status, created_at FROM users WHERE id = ?').get(u.id) });
});

router.post('/users/:id/reset-password', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  const pw = String(req.body.password || '');
  const err = validatePassword(pw);
  if (err) return res.status(400).json({ error: 'invalid_password', message: err });
  changePassword(u.id, pw);
  audit(req.user.id, req.user.username, 'admin.user_password_reset', { id: u.id }, req.ip);
  res.json({ ok: true, message: 'Password reset. The user has been signed out everywhere.' });
});

router.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'self', message: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req.user.id, req.user.username, 'admin.user_deleted', { id: u.id, username: u.username }, req.ip);
  res.json({ ok: true });
});

router.post('/users', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_.\-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username', message: 'Username must be 3–32 characters.' });
  }
  const err = validatePassword(password);
  if (err) return res.status(400).json({ error: 'invalid_password', message: err });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'taken', message: 'That username already exists.' });
  }
  const created = createUser({ username, email: req.body.email || null, password, role: req.body.role === 'admin' ? 'admin' : 'user' });
  audit(req.user.id, req.user.username, 'admin.user_created', { id: created.id, role: created.role }, req.ip);
  res.json({ user: created });
});

/* ───────────────────────── analytics ───────────────────────── */

router.get('/analytics', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '14', 10)));
  const daily = db.prepare(`
    WITH RECURSIVE d(day) AS (
      SELECT date('now', '-' || ? || ' day')
      UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now')
    )
    SELECT d.day AS day,
      COALESCE(SUM(CASE WHEN l.status = 'ok' THEN 1 ELSE 0 END), 0) AS requests,
      COALESCE(SUM(l.total_tokens), 0) AS tokens,
      COALESCE(SUM(l.cost_usd), 0) AS cost,
      COALESCE(SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END), 0) AS errors
    FROM d LEFT JOIN usage_log l ON date(l.created_at) = d.day
    GROUP BY d.day ORDER BY d.day`).all(days - 1);

  const byModel = db.prepare(`
    SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS requests,
           COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
    FROM usage_log WHERE created_at >= datetime('now', ?) GROUP BY model ORDER BY requests DESC LIMIT 10`)
    .all(`-${days} day`);

  const byKind = db.prepare(`
    SELECT kind, COUNT(*) AS requests FROM usage_log
    WHERE created_at >= datetime('now', ?) GROUP BY kind ORDER BY requests DESC`).all(`-${days} day`);

  const recentErrors = db.prepare(`
    SELECT id, created_at, model, kind, error, status FROM usage_log
    WHERE status = 'error' ORDER BY id DESC LIMIT 30`).all();

  const topUsers = db.prepare(`
    SELECT u.username, COUNT(*) AS requests, COALESCE(SUM(l.total_tokens),0) AS tokens
    FROM usage_log l JOIN users u ON u.id = l.user_id
    WHERE l.created_at >= datetime('now', ?) GROUP BY u.id ORDER BY requests DESC LIMIT 8`)
    .all(`-${days} day`);

  res.json({ days, daily, byModel, byKind, recentErrors, topUsers });
});

router.get('/audit', (_req, res) => {
  res.json({ entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all() });
});

module.exports = router;

