'use strict';
/**
 * FLASH AGENT — persistence layer (SQLite, WAL, durable across restarts).
 * Tables: users, sessions, conversations, messages, memories, providers,
 *         settings, usage_log, audit_log, password_resets.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const config = require('./config');

const db = new Database(config.DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  status        TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'suspended'
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT 'app',          -- 'app' | 'admin'
  ip         TEXT,
  ua         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  model      TEXT,
  mode       TEXT NOT NULL DEFAULT 'chat',         -- chat | code | vision | translate
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,                   -- user | assistant | system
  content         TEXT NOT NULL DEFAULT '',
  images          TEXT,                            -- JSON array of /uploads/... urls
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'ok',      -- ok | error | stopped
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',  -- manual | extracted
  conversation_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                       -- openai | gemini | xai | custom
  base_url    TEXT NOT NULL,
  api_key_enc TEXT,                                -- AES-256-GCM, never returned raw
  model       TEXT NOT NULL,
  models      TEXT,                                -- JSON array of selectable models
  temperature REAL NOT NULL DEFAULT 0.7,
  max_tokens  INTEGER NOT NULL DEFAULT 2048,
  vision      INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER,
  conversation_id   INTEGER,
  provider_id       INTEGER,
  provider          TEXT,
  model             TEXT,
  kind              TEXT NOT NULL DEFAULT 'chat',  -- chat | vision | tts | stt
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ok',
  error             TEXT,
  ms                INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  actor      TEXT,
  action     TEXT NOT NULL,
  meta       TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv   ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_user       ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created   ON usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user      ON usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_user   ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token  ON sessions(token_hash);
`);

/* ───────────────────────── settings ───────────────────────── */

const DEFAULT_SETTINGS = {
  app_name: 'FLASH AGENT',
  slogan: 'Your Intelligence. Beyond Limits.',
  logo_url: '/assets/logo.svg',
  theme: 'midnight',
  accent: 'electric',
  registration_enabled: config.ALLOW_REGISTRATION ? 'true' : 'false',
  maintenance_mode: 'false',
  maintenance_message: 'FLASH AGENT is upgrading its neural core. We will be back shortly.',
  // AI personality
  ai_name: 'FLASH',
  personality: 'precise, warm, and highly capable — a senior engineer and strategist in one',
  system_prompt:
    'You are FLASH, the AI core of the FLASH AGENT platform. Answer accurately and concisely, ' +
    'structure long answers with markdown, and use fenced code blocks with a language tag for code. ' +
    'If you are unsure, say so instead of inventing facts.',
  default_language: 'auto',
  arabic_dialect: 'libyan',
  creativity: 'balanced',           // precise | balanced | creative
  response_length: 'balanced',      // short | balanced | detailed
  // Limits
  daily_message_limit: '120',
  rate_limit_per_minute: '120',
  max_input_chars: '12000',
  // Billing estimate (USD per 1M tokens) used for the dashboard
  price_in_per_mtok: '0.15',
  price_out_per_mtok: '0.60',
  // Voice
  tts_voice: 'alloy',
  tts_speed: '1',
  stt_model: 'whisper-1',
  vision_model: 'gpt-4o-mini',
};

function seedSettings() {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => { for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, String(v)); });
  tx();
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function setSettings(obj) {
  const tx = db.transaction(() => { for (const [k, v] of Object.entries(obj)) setSetting(k, v); });
  tx();
}
function numSetting(key, fallback) {
  const n = parseFloat(getSetting(key, ''));
  return Number.isFinite(n) ? n : fallback;
}

/* ──────────────── provider API keys: AES-256-GCM ──────────────── */

const KEY = crypto.createHash('sha256').update(config.SECRET + ':provider-keys').digest();

function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}
function decryptSecret(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const [, ivB, tagB, dataB] = parts;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64url'));
    d.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64url')), d.final()]).toString('utf8');
  } catch { return ''; }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

/* ───────────────────────── providers ───────────────────────── */

const PROVIDER_PRESETS = {
  openai: { name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
  gemini: { name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  xai:    { name: 'xAI Grok', base_url: 'https://api.x.ai/v1', models: ['grok-2-latest', 'grok-beta'] },
  custom: { name: 'Custom OpenAI-compatible', base_url: 'https://your-endpoint/v1', models: ['custom-model'] },
};

function listProviders({ withSecrets = false } = {}) {
  const rows = db.prepare('SELECT * FROM providers ORDER BY active DESC, id ASC').all();
  return rows.map((r) => {
    const key = decryptSecret(r.api_key_enc);
    return {
      id: r.id, name: r.name, kind: r.kind, base_url: r.base_url,
      model: r.model, models: JSON.parse(r.models || '[]'),
      temperature: r.temperature, max_tokens: r.max_tokens,
      vision: !!r.vision, active: !!r.active, enabled: !!r.enabled,
      api_key_masked: maskKey(key),
      has_key: !!key,
      api_key: withSecrets ? key : undefined,
    };
  });
}
function getActiveProvider({ withSecrets = false } = {}) {
  const r = db.prepare('SELECT * FROM providers WHERE active = 1 AND enabled = 1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT * FROM providers WHERE enabled = 1 ORDER BY id LIMIT 1').get();
  if (!r) return null;
  const key = decryptSecret(r.api_key_enc);
  return {
    id: r.id, name: r.name, kind: r.kind, base_url: r.base_url,
    model: r.model, models: JSON.parse(r.models || '[]'),
    temperature: r.temperature, max_tokens: r.max_tokens,
    vision: !!r.vision, active: !!r.active,
    api_key: withSecrets === false ? undefined : key,
    api_key_masked: maskKey(key),
    has_key: !!key,
  };
}

function audit(actorId, actor, action, meta, ip) {
  try {
    db.prepare('INSERT INTO audit_log (actor_id, actor, action, meta, ip) VALUES (?,?,?,?,?)')
      .run(actorId || null, actor || null, action, meta ? JSON.stringify(meta) : null, ip || null);
  } catch { /* audit must never break a request */ }
}

module.exports = {
  db, config,
  seedSettings, getSetting, getSettings, setSetting, setSettings, numSetting,
  encryptSecret, decryptSecret, maskKey,
  listProviders, getActiveProvider, PROVIDER_PRESETS,
  audit, DEFAULT_SETTINGS,
};

