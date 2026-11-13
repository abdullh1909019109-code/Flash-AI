'use strict';
/**
 * FLASH AGENT — authentication & authorisation.
 * - bcrypt password hashing (cost 12)
 * - opaque session tokens (32 random bytes), stored only as SHA-256 hashes
 * - httpOnly / SameSite cookies, separate scope for the admin dashboard
 * - requireUser / requireAdmin guards, forced first-login password change
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');
const config = require('./config');

const USER_COOKIE = 'fa_session';
const ADMIN_COOKIE = 'fa_admin';
const SESSION_DAYS = 14;

const hashPassword = (pw) => bcrypt.hashSync(String(pw), 12);
const verifyPassword = (pw, hash) => {
  try { return bcrypt.compareSync(String(pw), hash); } catch { return false; }
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { days = SESSION_DAYS, path = '/' } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${days * 86400}`,
  ];
  if (config.IS_PROD) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}
function clearCookie(res, name, path = '/') {
  const bits = [`${name}=`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.IS_PROD) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function createSession(userId, scope, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token_hash, user_id, scope, ip, ua, expires_at) VALUES (?,?,?,?,?,?)')
    .run(sha256(token), userId, scope, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200), expires);
  setCookie(res, scope === 'admin' ? ADMIN_COOKIE : USER_COOKIE, token, { path: scope === 'admin' ? '/admin' : '/' });
  if (scope === 'admin') {
    // The admin dashboard also needs the app cookie for /api/* calls it makes,
    // but those calls are guarded by role check anyway.
    setCookie(res, USER_COOKIE, token, { path: '/' });
  }
  return token;
}

function destroySession(req, res, scope = 'app') {
  const name = scope === 'admin' ? ADMIN_COOKIE : USER_COOKIE;
  const token = parseCookies(req)[name];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  clearCookie(res, name, scope === 'admin' ? '/admin' : '/');
}

function userFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[USER_COOKIE] || cookies[ADMIN_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
    return null;
  }
  if (row.status !== 'active') return null;
  return {
    id: row.id, username: row.username, email: row.email, role: row.role,
    status: row.status, must_change_password: !!row.must_change_password,
    created_at: row.created_at, last_login_at: row.last_login_at,
    session_id: row.sid,
  };
}

/* ───────────────────────── middleware ───────────────────────── */

function attachUser(req, _res, next) {
  req.user = userFromRequest(req);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Please sign in to continue.' });
  if (req.user.must_change_password && !req.path.endsWith('/change-password')) {
    return res.status(403).json({ error: 'password_change_required', message: 'You must change your password before continuing.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Administrator sign-in required.' });
  if (req.user.role !== 'admin') {
    audit(req.user.id, req.user.username, 'admin.denied', { path: req.originalUrl }, req.ip);
    return res.status(403).json({ error: 'forbidden', message: 'Administrator access only.' });
  }
  next();
}

/* ───────────────────────── accounts ───────────────────────── */

function createUser({ username, email = null, password, role = 'user', mustChangePassword = 0 }) {
  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, role, must_change_password)
    VALUES (?,?,?,?,?)`).run(username, email, hashPassword(password), role, mustChangePassword ? 1 : 0);
  return db.prepare('SELECT id, username, email, role, status, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function changePassword(userId, newPassword) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(hashPassword(newPassword), userId);
  // invalidate every other session for that user
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

module.exports = {
  hashPassword, verifyPassword, createUser, changePassword, validatePassword,
  createSession, destroySession, userFromRequest, attachUser, requireUser, requireAdmin,
  parseCookies, sha256, USER_COOKIE, ADMIN_COOKIE,
};


