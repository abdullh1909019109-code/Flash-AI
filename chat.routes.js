'use strict';
/**
 * FLASH AGENT — conversations, chat streaming, memory, uploads.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSettings, numSetting } = require('../db');
const config = require('../config');
const engine = require('../engine');
const { requireUser } = require('../auth');
const { dailyQuota } = require('../rateLimit');

const router = express.Router();
router.use(requireUser);

/* ───────────────────────── helpers ───────────────────────── */

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function saveDataUrl(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('Unsupported image format. Use PNG, JPEG, WEBP or GIF.'), { status: 400 });
  const buf = Buffer.from(m[3].replace(/\s/g, ''), 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Image is too large (max 6 MB each).'), { status: 413 });
  }
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}`, mime: m[1], dataUrl: `data:${m[1]};base64,${buf.toString('base64')}` };
}

function ownedConversation(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/** Cheap lexical memory retrieval — no embeddings needed, deterministic. */
function relevantMemories(userId, query, limit = 8) {
  const all = db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId);
  if (!all.length) return [];
  const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const scored = all.map((m) => {
    const c = m.content.toLowerCase();
    let score = 0;
    for (const w of words) if (c.includes(w)) score += 1;
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score || b.m.id - a.m.id);
  return scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.m);
}

/* ───────────────────────── conversations ───────────────────────── */

router.get('/conversations', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.mode, c.model, c.pinned, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c WHERE c.user_id = ?
    ORDER BY c.pinned DESC, c.updated_at DESC`).all(req.user.id);
  res.json({ conversations: rows });
});

router.post('/conversations', (req, res) => {
  const mode = ['chat', 'code', 'vision', 'translate'].includes(req.body.mode) ? req.body.mode : 'chat';
  const info = db.prepare('INSERT INTO conversations (user_id, title, mode) VALUES (?,?,?)')
    .run(req.user.id, 'New conversation', mode);
  res.json({ conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid) });
});

router.get('/conversations/:id', (req, res) => {
  const c = ownedConversation(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
  const messages = db.prepare(`
    SELECT id, role, content, images, tokens_in, tokens_out, model, status, error, created_at
    FROM messages WHERE conversation_id = ? ORDER BY id ASC`).all(c.id)
    .map((m) => ({ ...m, images: m.images ? JSON.parse(m.images) : [] }));
  res.json({ conversation: c, messages });
});

router.patch('/conversations/:id', (req, res) => {
  const c = ownedConversation(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
  const title = String(req.body.title || '').trim().slice(0, 120);
  const pinned = req.body.pinned;
  if (title) db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, c.id);
  if (typeof pinned === 'boolean') db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, c.id);
  res.json({ conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id) });
});

router.delete('/conversations/:id', (req, res) => {
  const c = ownedConversation(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
  db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

router.delete('/conversations', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.delete('/messages/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/* ───────────────────────── memory ───────────────────────── */

router.get('/memories', (req, res) => {
  const memories = db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ memories });
});

router.post('/memories', (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'empty', message: 'Memory text cannot be empty.' });
  if (content.length > 500) return res.status(400).json({ error: 'too_long', message: 'Keep a memory under 500 characters.' });
  const info = db.prepare('INSERT INTO memories (user_id, content, source) VALUES (?,?,?)')
    .run(req.user.id, content, 'manual');
  res.json({ memory: db.prepare('SELECT * FROM memories WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/memories/:id', (req, res) => {
  const r = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found', message: 'Memory not found.' });
  res.json({ ok: true });
});

router.delete('/memories', (req, res) => {
  db.prepare('DELETE FROM memories WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/** Suggest memories from the last N messages; the user must accept them. */
router.post('/memories/suggest', async (req, res, next) => {
  try {
    const c = ownedConversation(req.body.conversationId, req.user.id);
    if (!c) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
    const messages = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 12').all(c.id).reverse();
    if (messages.length < 2) return res.json({ suggestions: [] });
    const suggestions = await engine.extractMemories({ messages, user: req.user, settings: getSettings() });
    const existing = new Set(db.prepare('SELECT content FROM memories WHERE user_id = ?').all(req.user.id).map((r) => r.content.toLowerCase()));
    res.json({ suggestions: suggestions.filter((s) => !existing.has(s.toLowerCase())) });
  } catch (e) { next(e); }
});

/* ───────────────────────── chat (SSE) ───────────────────────── */

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return { send, end: () => res.end() };
}

async function runTurn({ req, res, conversation, userText, images, mode, regenerateOf }) {
  const settings = getSettings();
  const io = sse(res);

  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  const startedAt = Date.now();
  let assistantRowId = null;

  try {
    // 1. user message
    let userMessage = null;
    if (!regenerateOf) {
      const storedImages = images.map(saveDataUrl);
      const info = db.prepare(`INSERT INTO messages (conversation_id, user_id, role, content, images)
        VALUES (?,?,?,?,?)`).run(conversation.id, req.user.id, 'user', userText,
        storedImages.length ? JSON.stringify(storedImages.map((i) => i.url)) : null);
      userMessage = { id: info.lastInsertRowid, role: 'user', content: userText, images: storedImages.map((i) => i.url) };
      db.prepare("UPDATE conversations SET updated_at = datetime('now'), title = CASE WHEN title = 'New conversation' THEN ? ELSE title END, mode = ? WHERE id = ?")
        .run(titleFrom(userText || 'Image analysis'), mode, conversation.id);
      io.send('user_message', userMessage);
    }

    // 2. history for the model
    const history = db.prepare(`SELECT role, content, images FROM messages
      WHERE conversation_id = ? ORDER BY id ASC`).all(conversation.id).slice(-24);

    const modelMessages = [];
    let lastImageDataUrls = images;
    for (const m of history) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const imgs = m.images ? JSON.parse(m.images) : [];
      if (m.role === 'user' && imgs.length && m.content === userText && !regenerateOf) {
        // fresh upload: use the in-memory data URLs
        modelMessages.push({ role: 'user', content: [
          ...lastImageDataUrls.map((d) => ({ type: 'image_url', image_url: { url: d } })),
          { type: 'text', text: userText || 'Describe this image.' },
        ] });
      } else if (m.role === 'user' && imgs.length) {
        // historical images: reference them by file path — re-read from disk
        const parts = [];
        for (const url of imgs) {
          const p = path.join(config.UPLOAD_DIR, path.basename(url));
          try {
            const b = fs.readFileSync(p);
            const mime = url.endsWith('.png') ? 'image/png' : url.endsWith('.webp') ? 'image/webp' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
            parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b.toString('base64')}` } });
          } catch { /* file gone */ }
        }
        parts.push({ type: 'text', text: m.content || 'Describe this image.' });
        modelMessages.push({ role: 'user', content: parts });
      } else {
        modelMessages.push({ role: m.role, content: m.content });
      }
    }
    if (regenerateOf || !history.some((m) => m.role === 'user' && m.content === userText)) {
      if (!regenerateOf && !modelMessages.length) {
        modelMessages.push({ role: 'user', content: userText || 'Describe this image.' });
      }
    }

    const memories = relevantMemories(req.user.id, userText || '');

    // 3. assistant placeholder row
    const row = db.prepare(`INSERT INTO messages (conversation_id, user_id, role, content, model, status)
      VALUES (?,?,?,?,?,?)`).run(conversation.id, req.user.id, 'assistant', '', null, 'streaming');
    assistantRowId = row.lastInsertRowid;
    io.send('start', { messageId: assistantRowId, model: null, mode });

    // 4. stream
    let acc = '';
    let lastFlush = 0;
    const result = await engine.stream({
      messages: modelMessages,
      mode,
      memories,
      user: req.user,
      settings,
      signal: controller.signal,
      userId: req.user.id,
      conversationId: conversation.id,
      kind: images.length ? 'vision' : 'chat',
    }, (delta) => {
      acc += delta;
      io.send('delta', { text: delta });
      const now = Date.now();
      if (now - lastFlush > 1200) { lastFlush = now; /* could persist partial text here */ }
    });

    finished = true;
    const finalText = result.text || acc;
    db.prepare(`UPDATE messages SET content = ?, model = ?, tokens_in = ?, tokens_out = ?, status = ?
      WHERE id = ?`).run(finalText, result.model, result.promptTokens, result.completionTokens,
      result.aborted ? 'stopped' : 'ok', assistantRowId);

    io.send('done', {
      messageId: assistantRowId,
      content: finalText,
      model: result.model,
      usage: { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens, cost_usd: result.cost },
      stopped: !!result.aborted,
      ms: Date.now() - startedAt,
    });
    io.end();
  } catch (e) {
    finished = true;
    const message = e.code ? e.message : (e.message || 'Generation failed.');
    if (assistantRowId) {
      db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run('error', `${e.code || ''} ${message}`.trim(), assistantRowId);
    }
    io.send('error', {
      code: e.code || 'error',
      message,
      hint: e.hint || '',
      messageId: assistantRowId,
    });
    io.end();
  }
}

router.post('/chat', dailyQuota, async (req, res, next) => {
  try {
    const settings = getSettings();
    const userText = String(req.body.message || '');
    const mode = ['chat', 'code', 'vision', 'translate'].includes(req.body.mode) ? req.body.mode : 'chat';
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, MAX_IMAGES) : [];

    const maxChars = numSetting('max_input_chars', 12000);
    if (!userText.trim() && !images.length) {
      return res.status(400).json({ error: 'empty', message: 'Write a message or attach an image first.' });
    }
    if (userText.length > maxChars) {
      return res.status(413).json({ error: 'too_long', message: `Message is too long (max ${maxChars} characters).` });
    }

    let conversation;
    if (req.body.conversationId) {
      conversation = ownedConversation(req.body.conversationId, req.user.id);
      if (!conversation) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
    } else {
      const info = db.prepare('INSERT INTO conversations (user_id, title, mode) VALUES (?,?,?)')
        .run(req.user.id, 'New conversation', mode);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    }

    await runTurn({ req, res, conversation, userText, images, mode });
  } catch (e) { next(e); }
});

router.post('/chat/regenerate', dailyQuota, async (req, res, next) => {
  try {
    const conversation = ownedConversation(req.body.conversationId, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });

    // Drop the last assistant message (and anything after it) then re-run the last user turn.
    const lastUser = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(conversation.id);
    if (!lastUser) return res.status(400).json({ error: 'nothing_to_regenerate', message: 'There is nothing to regenerate yet.' });
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversation.id, lastUser.id);

    const imgs = lastUser.images ? JSON.parse(lastUser.images) : [];
    // Rebuild image data URLs from disk so vision context survives regeneration.
    const images = [];
    for (const url of imgs) {
      const p = path.join(config.UPLOAD_DIR, path.basename(url));
      try {
        const b = fs.readFileSync(p);
        const mime = url.endsWith('.png') ? 'image/png' : url.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        images.push(`data:${mime};base64,${b.toString('base64')}`);
      } catch { /* ignore */ }
    }
    await runTurn({ req, res, conversation, userText: lastUser.content, images, mode: conversation.mode || 'chat', regenerateOf: lastUser.id });
  } catch (e) { next(e); }
});

/* ───────────────────────── connection status for the UI ───────────────────────── */

router.get('/ai/status', (req, res) => {
  const { provider } = engine.resolveProvider();
  const s = getSettings();
  const today = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost_usd),0) AS c FROM usage_log WHERE date(created_at) = date('now') AND status = 'ok'").get();
  res.json({
    configured: !!(provider && provider.api_key && provider.base_url),
    provider: provider ? provider.name : null,
    model: provider ? provider.model : null,
    vision_model: s.vision_model,
    maintenance: s.maintenance_mode === 'true',
    ai_name: s.ai_name, app_name: s.app_name, slogan: s.slogan, logo_url: s.logo_url,
    usage_today: { requests: today.n, tokens: today.t, cost_usd: Number(today.c.toFixed(6)) },
  });
});

module.exports = router;

