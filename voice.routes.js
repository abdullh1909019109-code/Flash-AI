'use strict';
/** FLASH AGENT — FLASH VOICE: speech-to-text and text-to-speech. */
const express = require('express');
const engine = require('../engine');
const { requireUser } = require('../auth');
const { db } = require('../db');

const router = express.Router();

router.post('/transcribe', requireUser, async (req, res, next) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1000) {
      return res.status(400).json({ error: 'empty_audio', message: 'No audio was received. Hold the mic button and speak.' });
    }
    if (buf.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'audio_too_large', message: 'Recording is too long (max 25 MB).' });
    }
    const language = String(req.query.language || 'auto');
    const result = await engine.transcribe({
      buffer: buf,
      mime: req.headers['content-type'] || 'audio/webm',
      filename: `clip.${(req.headers['content-type'] || '').includes('mp4') ? 'm4a' : 'webm'}`,
      language,
      userId: req.user.id,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/speak', requireUser, async (req, res, next) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty', message: 'There is no text to speak.' });
    const audio = await engine.speak({
      text,
      voice: req.body.voice,
      speed: req.body.speed,
      userId: req.user.id,
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(audio);
  } catch (e) { next(e); }
});

router.get('/voices', requireUser, (_req, res) => {
  res.json({
    voices: [
      { id: 'alloy', label: 'Alloy — neutral, balanced' },
      { id: 'nova', label: 'Nova — bright, female' },
      { id: 'shimmer', label: 'Shimmer — soft, female' },
      { id: 'echo', label: 'Echo — warm, male' },
      { id: 'onyx', label: 'Onyx — deep, male' },
      { id: 'fable', label: 'Fable — expressive' },
      { id: 'sage', label: 'Sage — calm' },
      { id: 'coral', label: 'Coral — friendly' },
    ],
  });
});

module.exports = router;

