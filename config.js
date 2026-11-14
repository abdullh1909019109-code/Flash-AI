'use strict';

/**
 * FLASH AGENT — configuration loader.
 * Reads .env and exposes paths + secrets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// المجلد الرئيسي للمشروع
const ROOT = __dirname;

function loadEnv() {
  const file = process.env.ENV_FILE || path.join(ROOT, '.env');

  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const DATA_DIR = path.resolve(
  ROOT,
  process.env.DATA_DIR || './data'
);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const APP_SECRET = process.env.APP_SECRET || '';

if (APP_SECRET.length < 16) {
  const secretFile = path.join(DATA_DIR, '.fallback-secret');

  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(
      secretFile,
      crypto.randomBytes(48).toString('base64url'),
      { mode: 0o600 }
    );
  }

  console.warn(
    '[FLASH AGENT] WARNING: APP_SECRET not set. Set APP_SECRET in production.'
  );
}

const config = {
  ROOT,

  DATA_DIR,

  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),

  DB_FILE: path.join(DATA_DIR, 'flash-agent.db'),

  PORT: parseInt(process.env.PORT || '3000', 10),

  APP_URL:
    process.env.APP_URL ||
    `http://localhost:${process.env.PORT || 3000}`,

  IS_PROD: process.env.NODE_ENV === 'production',

  SECRET:
    APP_SECRET.length >= 16
      ? APP_SECRET
      : fs.readFileSync(
          path.join(DATA_DIR, '.fallback-secret'),
          'utf8'
        ).trim(),

  OPENAI: {
    apiKey: process.env.OPENAI_API_KEY || '',

    baseUrl: (
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, ''),

    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',

  ADMIN_INITIAL_PASSWORD:
    process.env.ADMIN_INITIAL_PASSWORD || '',

  ALLOW_REGISTRATION:
    (process.env.ALLOW_REGISTRATION || 'true') !== 'false',

  VERSION: '1.0.0',

  BRAND: 'FLASH AGENT',

  SLOGAN: 'Your Intelligence. Beyond Limits.',
};

module.exports = config;