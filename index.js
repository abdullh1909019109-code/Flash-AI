'use strict';

/**
 * FLASH AGENT — HTTP server.
 * Public app at /, admin dashboard at /admin, API at /api.
 */

const express = require('express');
const path = require('path');

const config = require('./config');
const { attachUser } = require('./auth');
const { getSettings, db } = require('./db');
const { apiLimiter } = require('./rateLimit');
const { seed } = require('./seed');

seed();

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

/* Security headers */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (config.IS_PROD) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  next();
});

/* Request bodies */

app.use(
  '/api/voice/transcribe',
  express.raw({
    type: ['audio/*', 'application/octet-stream'],
    limit: '26mb'
  })
);

app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(attachUser);

/* Uploads */

app.use(
  '/uploads',
  express.static(config.UPLOAD_DIR, {
    maxAge: '7d',
    index: false
  })
);

/*
 * Static files are in the project root.
 * Only public files are exposed.
 */

const publicFiles = [
  'index.html',
  'admin.html',
  'favicon.svg',
  'logo.svg',
  'logo-maskable.svg',
  'admin.css',
  'markdown.js',
  'app.css',
  'app.js',
  'admin.js',
  'sw.js',
  'manifest.webmanifest'
];

for (const file of publicFiles) {
  app.get('/' + file, (req, res) => {
    res.sendFile(path.join(config.ROOT, file));
  });
}

/* Health checks */

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'FLASH AGENT' });
});

app.get('/api/health', (_req, res