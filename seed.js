'use strict';
/**
 * FLASH AGENT — first-boot seeding.
 * Creates settings defaults, the administrator account (bcrypt-hashed, forced
 * password change) and the initial OpenAI provider. Idempotent: safe on every boot.
 */
const { db, config, seedSettings, setSetting, getSetting, encryptSecret, PROVIDER_PRESETS } = require('./db');
const { hashPassword, validatePassword } = require('./auth');

function seed() {
  seedSettings();

  // ── administrator ──
  const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (adminCount === 0) {
    const username = config.ADMIN_USERNAME;
    const password = config.ADMIN_INITIAL_PASSWORD;
    if (!password) {
      console.error('[seed] ADMIN_INITIAL_PASSWORD is not set — no administrator was created.');
      console.error('[seed] Set ADMIN_INITIAL_PASSWORD in .env and restart to create the admin account.');
    } else {
      const pwErr = validatePassword(password);
      if (pwErr) console.warn(`[seed] WARNING: initial admin password is weak — ${pwErr} It will be hashed and you will be forced to change it.`);
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        db.prepare("UPDATE users SET role = 'admin', password_hash = ?, must_change_password = 1, status = 'active' WHERE id = ?")
          .run(hashPassword(password), existing.id);
        console.log(`[seed] Promoted existing user "${username}" to administrator.`);
      } else {
        db.prepare(`INSERT INTO users (username, password_hash, role, must_change_password)
          VALUES (?,?, 'admin', 1)`).run(username, hashPassword(password));
        console.log(`[seed] Administrator "${username}" created (password change required at first sign-in).`);
      }
    }
  }

  // ── initial provider ──
  const providerCount = db.prepare('SELECT COUNT(*) AS n FROM providers').get().n;
  if (providerCount === 0) {
    const apiKey = config.OPENAI.apiKey;
    db.prepare(`INSERT INTO providers (name, kind, base_url, api_key_enc, model, models, temperature, max_tokens, vision, active, enabled)
      VALUES (?,?,?,?,?,?,?,?,1,1,1)`).run(
      PROVIDER_PRESETS.openai.name, 'openai', config.OPENAI.baseUrl,
      apiKey ? encryptSecret(apiKey) : null,
      config.OPENAI.model, JSON.stringify(PROVIDER_PRESETS.openai.models), 0.7, 2048,
    );
    console.log(`[seed] OpenAI provider created (model ${config.OPENAI.model}, key ${apiKey ? 'stored encrypted' : 'MISSING — set it in the admin dashboard'}).`);
  }

  // keep first-run flags consistent with env
  if (getSetting('registration_enabled') === null) {
    setSetting('registration_enabled', config.ALLOW_REGISTRATION ? 'true' : 'false');
  }
}

module.exports = { seed };

if (require.main === module) {
  seed();
  console.log('[seed] done.');
}

