'use strict';
/**
 * FLASH AGENT — rate limiting (in-memory sliding window, per IP and per user)
 * plus a daily message quota sourced from admin settings.
 */
const { db, numSetting } = require('./db');

const buckets = new Map(); // key -> [timestamps]

function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return { allowed: arr.length <= limit, remaining: Math.max(0, limit - arr.length), retryAfter: Math.ceil(windowMs / 1000) };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const kept = arr.filter((t) => now - t < 10 * 60e3);
    if (!kept.length) buckets.delete(k); else buckets.set(k, kept);
  }
}, 60e3).unref();

/** Hard per-minute limiter for every /api route. */
function apiLimiter(req, res, next) {
  const limit = Math.max(20, numSetting('rate_limit_per_minute', 120));
  res.setHeader('X-RateLimit-Limit', String(limit));
  // Administrators are never throttled — the dashboard bursts many calls.
  if (req.user && req.user.role === 'admin') {
    res.setHeader('X-RateLimit-Remaining', String(limit));
    return next();
  }
  const key = `${req.user ? 'u' + req.user.id : 'ip' + (req.ip || 'x')}`;
  const r = hit(key, limit, 60e3);
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please slow down and try again in a minute.' });
  }
  next();
}

/** Brute-force protection for login endpoints. */
function loginLimiter(req, res, next) {
  const key = `login:${req.ip}:${(req.body && req.body.username) || ''}`;
  const r = hit(key, 10, 10 * 60e3);
  if (!r.allowed) return res.status(429).json({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' });
  next();
}

function dailyMessagesUsed(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    WHERE m.user_id = ? AND m.role = 'user' AND date(m.created_at) = date('now')`).get(userId);
  return row ? row.n : 0;
}

function dailyQuota(req, res, next) {
  if (!req.user) return next();
  if (req.user.role === 'admin') return next();
  const limit = numSetting('daily_message_limit', 120);
  const used = dailyMessagesUsed(req.user.id);
  if (used >= limit) {
    return res.status(429).json({
      error: 'daily_limit_reached',
      message: `You have reached today's limit of ${limit} messages. It resets at 00:00 UTC.`,
      limit, used,
    });
  }
  res.setHeader('X-Daily-Limit', String(limit));
  res.setHeader('X-Daily-Used', String(used));
  next();
}

module.exports = { apiLimiter, loginLimiter, dailyQuota, dailyMessagesUsed };

