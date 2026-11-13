'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSettings, numSetting, audit } = require('../db');
const config = require('../config');
const { createUser, verifyPassword, changePassword, validatePassword, createSession, destroySession, requireUser } = require('../auth');
const { loginLimiter, apiLimiter } = require('../rateLimit');

const router = express.Router();

const publicUser = (u) => ({
  id: u.id, username: u.username, email: u.email, role: u.role,
  status: u.status, must_change_password: !!u.must_change_password,
  created_at: u.created_at, last_login_at: u.last_login_at,
});

router.post('/register', apiLimiter, loginLimiter, (req, res) => {
  const s = getSettings();
  if (s.registration_enabled !== 'true') {
    return res.status(403).json({ error: 'registration_disabled', message: 'Registration is currently closed.' });
  }
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const password = String(req.body.password || '');

  if (!/^[a-zA-Z0-9_.\-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username', message: 'Username must be 3–32 characters (letters, numbers, . _ -).' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address is not valid.' });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: 'invalid_password', message: pwErr });

  const exists = db.prepare('SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(username, email);
  if (exists) return res.status(409).json({ error: 'taken', message: 'That username or email is already registered.' });

  const user = createUser({ username, email, password, role: 'user' });
  createSession(user.id, 'app', req, res);
  audit(user.id, username, 'user.register', null, req.ip);
  res.json({ user: publicUser({ ...user, status: 'active', must_change_password: 0 }) });
});

router.post('/login', apiLimiter, loginLimiter, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(username, username.toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) {
    audit(row ? row.id : null, username, 'auth.failed', null, req.ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect username or password.' });
  }
  if (row.status !== 'active') {
    return res.status(403).json({ error: 'suspended', message: 'This account has been suspended. Contact the administrator.' });
  }
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  createSession(row.id, row.role === 'admin' ? 'admin' : 'app', req, res);
  audit(row.id, row.username, 'auth.login', { role: row.role }, req.ip);
  res.json({ user: publicUser(row) });
});

router.post('/logout', (req, res) => {
  destroySession(req, res, 'app');
  destroySession(req, res, 'admin');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', requireUser, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Your current password is incorrect.' });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: 'invalid_password', message: pwErr });
  if (verifyPassword(newPassword, row.password_hash)) {
    return res.status(400).json({ error: 'same_password', message: 'Choose a password different from the current one.' });
  }
  changePassword(req.user.id, newPassword);
  // Re-issue a session so the current client stays signed in.
  createSession(req.user.id, req.user.role === 'admin' ? 'admin' : 'app', req, res);
  audit(req.user.id, req.user.username, 'auth.password_changed', null, req.ip);
  res.json({ ok: true, message: 'Password updated.' });
});

module.exports = router;

