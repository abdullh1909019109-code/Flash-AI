/* ══════════════════════════════════════════════════════════
   FLASH AGENT — public application client
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null,
    config: {},
    conversations: [],
    currentId: null,
    messages: [],
    mode: 'chat',
    attachments: [],
    streaming: false,
    controller: null,
    voices: [],
    speakEnabled: localStorage.getItem('fa_speak') === '1',
    voice: localStorage.getItem('fa_voice') || '',
    speed: parseFloat(localStorage.getItem('fa_speed') || '1'),
    dailyLimit: null,
    dailyUsed: null,
    status: null,
  };

  /* ─────────────── api ─────────────── */

  async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { ...headers } };
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body !== undefined) {
      opts.body = body;
    }
    const res = await fetch(path, opts);
    if (raw) return res;
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error;
      err.hint = data && data.hint;
      throw err;
    }
    return data;
  }

  function toast(msg, kind = '') {
    const n = el('div', `toast ${kind}`, esc(msg));
    $('#toasts').appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; n.style.transform = 'translateX(16px)'; n.style.transition = 'all .3s'; }, 3200);
    setTimeout(() => n.remove(), 3600);
  }

  /* ─────────────── boot ─────────────── */

  async function boot() {
    try {
      state.config = await (await fetch('/api/public/config')).json();
    } catch { /* offline-ish */ }
    applyBrand();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const { user } = await api('/api/auth/me');
    if (user) enterApp(user); else showAuth();
    loadVoices();
  }

  function applyBrand() {
    const c = state.config || {};
    if (c.app_name) {
      document.title = `${c.app_name} — ${c.slogan || ''}`.trim();
      $('#brandName').textContent = c.app_name;
      $('#authTitle').textContent = c.app_name;
    }
    if (c.slogan) $('#authTag').textContent = c.slogan;
    if (c.logo_url) $$('img[src="/assets/logo.svg"]').forEach((i) => { i.src = c.logo_url; });
  }

  function showAuth() {
    $('#app').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    if (state.config && state.config.registration_enabled === false) {
      $('#toRegister').closest('.auth-switch').classList.add('hidden');
    }
  }

  /* ─────────────── auth ─────────────── */

  $('#toRegister').addEventListener('click', () => {
    $('#loginForm').classList.add('hidden');
    $('#registerForm').classList.remove('hidden');
  });
  $('#toLogin').addEventListener('click', () => {
    $('#registerForm').classList.add('hidden');
    $('#loginForm').classList.remove('hidden');
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: {
        username: $('#loginUser').value.trim(), password: $('#loginPass').value,
      } });
      enterApp(user);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Enter FLASH AGENT';
    }
  });

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { user } = await api('/api/auth/register', { method: 'POST', body: {
        username: $('#regUser').value.trim(), email: $('#regEmail').value.trim(), password: $('#regPass').value,
      } });
      enterApp(user);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Create account';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  function enterApp(user) {
    state.user = user;
    $('#authScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#userName').textContent = user.username;
    $('#userAvatar').textContent = user.username.slice(0, 1).toUpperCase();
    $('#userRole').textContent = user.role === 'admin' ? 'administrator' : 'member';

    loadStatus();
    loadConversations();
    loadMemories();
    renderEmpty();
    updateSpeakToggle();

    if (user.must_change_password) openPasswordModal(true);
  }

  /* ─────────────── status ─────────────── */

  async function loadStatus() {
    try {
      const s = await api('/api/ai/status');
      state.status = s;
      const pill = $('#aiPill');
      const text = $('#aiPillText');
      $('#modelPill').textContent = s.model || '—';
      pill.className = 'pill';
      if (!s.configured) {
        pill.classList.add('bad'); text.textContent = 'AI not configured';
        pill.title = 'No API key is set for the active provider. An administrator must configure it at /admin.';
      } else {
        pill.classList.add('warn'); text.textContent = 'AI ready';
        pill.title = `${s.provider} · ${s.model}`;
      }
    } catch (e) {
      $('#aiPill').className = 'pill bad';
      $('#aiPillText').textContent = 'offline';
    }
  }

  /* ─────────────── conversations list ─────────────── */

  async function loadConversations() {
    try {
      const { conversations } = await api('/api/conversations');
      state.conversations = conversations;
      renderConversations();
    } catch (e) { toast(e.message, 'err'); }
  }

  function groupLabel(dateStr) {
    const d = new Date(dateStr.replace(' ', 'T') + 'Z');
    const now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days <= 7) return 'Previous 7 days';
    if (days <= 30) return 'Previous 30 days';
    return 'Older';
  }

  function renderConversations() {
    const list = $('#convList');
    const q = ($('#convSearch').value || '').toLowerCase().trim();
    list.innerHTML = '';
    const filtered = state.conversations.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
    if (!filtered.length) {
      list.appendChild(el('div', 'conv-group-label', q ? 'No matches' : 'No conversations yet'));
      return;
    }
    let group = '';
    for (const c of filtered) {
      const g = c.pinned ? 'Pinned' : groupLabel(c.updated_at);
      if (g !== group) { group = g; list.appendChild(el('div', 'conv-group-label', esc(g))); }
      const item = el('div', `conv-item${c.id === state.currentId ? ' active' : ''}`);
      item.dataset.id = c.id;
      item.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.55;flex:0 0 13px"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3Z"/></svg>
        <span class="t">${esc(c.title || 'New conversation')}</span>
        <span class="acts">
          <button class="icon-btn" data-act="rename" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button class="icon-btn danger" data-act="delete" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>
        </span>`;
      item.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) {
          e.stopPropagation();
          if (act.dataset.act === 'rename') renameConversation(c);
          if (act.dataset.act === 'delete') deleteConversation(c);
          return;
        }
        openConversation(c.id);
        closeSidebar();
      });
      list.appendChild(item);
    }
  }

  $('#convSearch').addEventListener('input', renderConversations);

  function renameConversation(c) {
    modal({
      title: 'Rename conversation',
      body: `<div class="field"><label>Title</label><input class="input" id="mTitle" value="${esc(c.title)}" maxlength="120"></div>`,
      actions: [
        { label: 'Cancel', cls: 'ghost' },
        { label: 'Save', cls: 'primary', onClick: async (root) => {
          const title = root.querySelector('#mTitle').value.trim();
          if (!title) return false;
          await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: { title } });
          await loadConversations();
          toast('Renamed', 'ok');
        } },
      ],
    });
  }

  function deleteConversation(c) {
    modal({
      title: 'Delete conversation?',
      body: `<p class="sub">“${esc(c.title)}” and all of its messages will be permanently removed. This cannot be undone.</p>`,
      actions: [
        { label: 'Cancel', cls: 'ghost' },
        { label: 'Delete', cls: 'danger', onClick: async () => {
          await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
          if (state.currentId === c.id) newChat();
          await loadConversations();
          toast('Conversation deleted', 'ok');
        } },
      ],
    });
  }

  async function openConversation(id) {
    try {
      const { conversation, messages } = await api(`/api/conversations/${id}`);
      state.currentId = conversation.id;
      state.messages = messages;
      state.mode = conversation.mode || 'chat';
      setMode(state.mode, false);
      renderMessages();
      renderConversations();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ─────────────── rendering messages ─────────────── */

  function renderEmpty() {
    const inner = $('#chatInner');
    inner.innerHTML = `
      <div class="hero">
        <img class="hero-logo" src="${esc(state.config.logo_url || '/assets/logo.svg')}" alt="">
        <div class="hero-badge">⚡ ${esc(state.config.app_name || 'FLASH AGENT')} · Intelligence Core</div>
        <h1>Your intelligence.<br><span class="grad">Beyond limits.</span></h1>
        <p class="slogan">Chat, code, vision and voice — one core, in Arabic and English.</p>
        <div class="cards">
          <button class="card-sug" data-prompt="اشرح لي أساسيات الذكاء الاصطناعي في نقاط بسيطة." data-mode="chat">
            <div class="ic">🌍</div><b>اسأل بالعربي</b><span>اشرح لي أساسيات الذكاء الاصطناعي ببساطة.</span></button>
          <button class="card-sug" data-prompt="Write a Python function that finds the longest palindromic substring, with explanation and tests." data-mode="code">
            <div class="ic">⌨️</div><b>Flash Code</b><span>Generate, explain and debug real code.</span></button>
          <button class="card-sug" data-prompt="Analyse this business idea: a subscription service for home solar maintenance in North Africa. Give strengths, risks and a go-to-market plan." data-mode="chat">
            <div class="ic">📊</div><b>Business analysis</b><span>Strategy, risks and a go-to-market plan.</span></button>
          <button class="card-sug" data-prompt="Attach an image and I will describe it, read its text and answer questions about it." data-mode="vision">
            <div class="ic">👁️</div><b>Flash Vision</b><span>Upload an image and ask anything about it.</span></button>
        </div>
      </div>`;
    $$('.card-sug').forEach((b) => b.addEventListener('click', () => {
      setMode(b.dataset.mode);
      if (b.dataset.mode === 'vision') { $('#fileInput').click(); return; }
      $('#input').value = b.dataset.prompt;
      $('#input').focus();
      autoGrow();
    }));
  }

  function timeLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function messageNode(msg, opts = {}) {
    const isUser = msg.role === 'user';
    const wrap = el('div', `msg ${isUser ? 'user' : 'assistant'}`);
    wrap.dataset.id = msg.id || '';
    const av = el('div', 'msg-av', isUser ? esc((state.user?.username || 'U').slice(0, 1).toUpperCase())
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2 5 13.5h5.5L9 22l8.5-11.5H12L13.5 2Z"/></svg>`);
    const body = el('div', 'msg-body');

    const head = el('div', 'msg-head',
      `<b>${isUser ? esc(state.user?.username || 'You') : esc(state.config.ai_name || 'FLASH')}</b>
       <time>${timeLabel(msg.created_at)}</time>${msg.model ? `<span class="pill" style="font-size:10px;padding:1px 7px">${esc(msg.model)}</span>` : ''}`);
    body.appendChild(head);

    if (isUser) {
      if (Array.isArray(msg.images) && msg.images.length) {
        const at = el('div', 'attachments');
        msg.images.forEach((u) => { const im = el('img'); im.src = u; im.alt = 'attachment'; at.appendChild(im); });
        body.appendChild(at);
      }
      if (msg.content) body.appendChild(el('div', 'bubble', esc(msg.content)));
    } else {
      const md = el('div', 'md');
      md.innerHTML = msg.content ? window.FlashMD.render(msg.content) : '';
      body.appendChild(md);
      if (msg.error) body.appendChild(errorBanner(msg.error));
      const actions = el('div', 'msg-actions');
      actions.innerHTML = `
        <button class="act" data-act="copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>Copy</button>
        <button class="act" data-act="speak"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>Speak</button>
        <button class="act" data-act="regen"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>Regenerate</button>
        <button class="act" data-act="delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>Delete</button>`;
      if (opts.live) actions.classList.add('show');
      body.appendChild(actions);
    }
    wrap.appendChild(av);
    wrap.appendChild(body);
    return wrap;
  }

  function errorBanner(text) {
    const [code, ...rest] = String(text).split(' ');
    const b = el('div', 'banner');
    b.innerHTML = `<div><b>${esc(prettyCode(code))}</b>${esc(rest.join(' ') || 'The AI request could not be completed.')}</div>`;
    return b;
  }

  function prettyCode(code) {
    return ({
      insufficient_credits: 'AI provider has no credits',
      invalid_api_key: 'API key rejected',
      network_error: 'Network failure',
      provider_rate_limited: 'Rate limited by provider',
      no_api_key: 'No API key configured',
      model_not_found: 'Model not available',
      aborted: 'Stopped',
      error: 'Generation failed',
    })[code] || 'Generation failed';
  }

  function renderMessages() {
    const inner = $('#chatInner');
    if (!state.messages.length) { renderEmpty(); return; }
    inner.innerHTML = '';
    for (const m of state.messages) {
      inner.appendChild(messageNode(m));
    }
    scrollBottom(true);
  }

  function scrollBottom(force) {
    const s = $('#chatScroll');
    const near = s.scrollHeight - s.scrollTop - s.clientHeight < 220;
    if (force || near) s.scrollTop = s.scrollHeight;
  }

  /* ─────────────── message interactions ─────────────── */

  $('#chatInner').addEventListener('click', async (e) => {
    const codeBtn = e.target.closest('[data-act="copy-code"], [data-act="download-code"]');
    if (codeBtn) {
      const wrap = codeBtn.closest('.code-wrap');
      const raw = decodeURIComponent(wrap.querySelector('code').dataset.raw || '');
      if (codeBtn.dataset.act === 'copy-code') {
        await navigator.clipboard.writeText(raw).then(() => {
          codeBtn.textContent = 'Copied';
          setTimeout(() => { codeBtn.textContent = 'Copy'; }, 1600);
        });
      } else {
        const lang = codeBtn.dataset.lang || 'txt';
        const ext = ({ js: 'js', ts: 'ts', python: 'py', php: 'php', html: 'html', css: 'css', sql: 'sql', go: 'go', rust: 'rs', bash: 'sh' })[lang] || 'txt';
        const blob = new Blob([raw], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `flash-agent-snippet.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      return;
    }

    const act = e.target.closest('.msg-actions [data-act]');
    if (!act) return;
    const msgNode = act.closest('.msg');
    const id = Number(msgNode.dataset.id);
    const msg = state.messages.find((m) => Number(m.id) === id);
    const kind = act.dataset.act;

    if (kind === 'copy') {
      const text = msg ? msg.content : msgNode.querySelector('.md').innerText;
      await navigator.clipboard.writeText(text);
      act.innerHTML = 'Copied ✓';
      setTimeout(() => { act.innerHTML = 'Copy'; }, 1500);
    }
    if (kind === 'speak' && msg) speakMessage(msg.content);
    if (kind === 'regenerate') regenerate();
    if (kind === 'delete' && msg) {
      await api(`/api/messages/${msg.id}`, { method: 'DELETE' });
      state.messages = state.messages.filter((m) => m.id !== msg.id);
      msgNode.remove();
      if (!state.messages.length) renderEmpty();
    }
  });

  /* ─────────────── chat ─────────────── */

  function setMode(mode, clear = true) {
    state.mode = mode;
    $$('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    const ph = {
      chat: 'Ask FLASH anything…',
      code: 'Describe the program, the bug, or paste the code…',
      vision: 'Attach an image, then ask what you want to know…',
      translate: 'Paste text to translate — Arabic ⇄ English, any language…',
    }[mode];
    $('#input').placeholder = ph;
    if (clear && state.currentId === null) renderEmpty();
  }

  $$('.mode-tab').forEach((t) => t.addEventListener('click', () => {
    setMode(t.dataset.mode);
    if (t.dataset.mode === 'vision') $('#fileInput').click();
  }));

  function newChat() {
    state.currentId = null;
    state.messages = [];
    state.attachments = [];
    renderAttachments();
    renderConversations();
    renderEmpty();
    $('#input').value = '';
    autoGrow();
    $('#input').focus();
  }
  $('#newChatBtn').addEventListener('click', () => { newChat(); closeSidebar(); });

  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(190, t.scrollHeight) + 'px';
  }
  $('#input').addEventListener('input', autoGrow);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  /* ─────────────── attachments ─────────────── */

  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []).slice(0, 4 - state.attachments.length);
    for (const f of files) {
      if (f.size > 6 * 1024 * 1024) { toast(`${f.name} is larger than 6 MB`, 'err'); continue; }
      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      state.attachments.push({ name: f.name, dataUrl });
    }
    e.target.value = '';
    renderAttachments();
    if (state.mode !== 'vision' && state.attachments.length) setMode('vision');
  });

  function renderAttachments() {
    const box = $('#attachPreview');
    box.innerHTML = '';
    box.classList.toggle('hidden', !state.attachments.length);
    state.attachments.forEach((a, i) => {
      const item = el('div', 'attach-item', `<img src="${a.dataUrl}" alt=""><button title="Remove">×</button>`);
      item.querySelector('button').addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      box.appendChild(item);
    });
  }

  async function send() {
    if (state.streaming) return;
    const input = $('#input');
    const text = input.value.trim();
    if (!text && !state.attachments.length) return;

    const payload = {
      message: text,
      mode: state.mode,
      images: state.attachments.map((a) => a.dataUrl),
      conversationId: state.currentId || undefined,
    };
    input.value = '';
    autoGrow();
    state.attachments = [];
    renderAttachments();
    await streamRequest('/api/chat', payload, { optimisticUser: text });
  }

  async function regenerate() {
    if (state.streaming || !state.currentId) return;
    // remove trailing assistant bubbles from view, keep the user turn
    const lastUserIdx = state.messages.map((m) => m.role).lastIndexOf('user');
    state.messages = state.messages.slice(0, lastUserIdx + 1);
    renderMessages();
    await streamRequest('/api/chat/regenerate', { conversationId: state.currentId }, {});
  }

  function setStreaming(on) {
    state.streaming = on;
    const btn = $('#sendBtn');
    btn.classList.toggle('stop', on);
    btn.innerHTML = on
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>'
      : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="m13 6 6 6-6 6"/></svg>';
    btn.title = on ? 'Stop generating' : 'Send (Enter)';
  }

  $('#sendBtn').addEventListener('click', () => {
    if (state.streaming) {
      if (state.controller) state.controller.abort();
      return;
    }
    send();
  });

  /** POST and consume the SSE stream. */
  async function streamRequest(url, payload, { optimisticUser } = {}) {
    const inner = $('#chatInner');
    if (!state.messages.length) inner.innerHTML = '';

    // optimistic user bubble
    if (optimisticUser !== undefined) {
      const tempUser = {
        id: `tmp-${Date.now()}`, role: 'user', content: optimisticUser,
        images: [], created_at: new Date().toISOString(),
      };
      state.messages.push(tempUser);
      inner.appendChild(messageNode(tempUser));
    }

    const live = el('div', 'msg assistant');
    live.innerHTML = `<div class="msg-av"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2 5 13.5h5.5L9 22l8.5-11.5H12L13.5 2Z"/></svg></div>
      <div class="msg-body"><div class="msg-head"><b>${esc(state.config.ai_name || 'FLASH')}</b><time>now</time></div>
      <div class="md"><div class="typing"><i></i><i></i><i></i></div></div></div>`;
    inner.appendChild(live);
    scrollBottom(true);

    const mdBox = live.querySelector('.md');
    let acc = '';
    let firstDelta = true;
    const controller = new AbortController();
    state.controller = controller;
    setStreaming(true);
    $('#aiPill').className = 'pill warn';
    $('#aiPillText').textContent = 'thinking…';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch { /* noop */ }
        throw Object.assign(new Error((data && data.message) || `Request failed (${res.status})`),
          { code: data && data.error, hint: data && data.hint });
      }

      const lim = res.headers.get('X-Daily-Limit');
      const used = res.headers.get('X-Daily-Used');
      if (lim) { state.dailyLimit = Number(lim); }
      if (used) { state.dailyUsed = Number(used) + 1; }
      if (lim) updateQuotaHint();

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let newConvId = null;
      let donePayload = null;
      let errorPayload = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let event = 'message';
          let data = '';
          for (const l of lines) {
            if (l.startsWith('event:')) event = l.slice(6).trim();
            else if (l.startsWith('data:')) data += l.slice(5).trim();
          }
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { continue; }

          if (event === 'user_message' && parsed) {
            const tmp = state.messages.find((m) => String(m.id).startsWith('tmp-'));
            if (tmp) tmp.id = parsed.id;
            const node = inner.querySelector('.msg.user:last-of-type');
            if (node) node.dataset.id = parsed.id;
            if (state.currentId === null) { /* id arrives with done */ }
          }
          if (event === 'start' && parsed) {
            live.dataset.id = parsed.messageId;
          }
          if (event === 'delta' && parsed) {
            if (firstDelta) { mdBox.innerHTML = ''; firstDelta = false; }
            acc += parsed.text;
            mdBox.innerHTML = window.FlashMD.render(acc) + '<span class="cursor-blink"></span>';
            scrollBottom(false);
          }
          if (event === 'done' && parsed) donePayload = parsed;
          if (event === 'error' && parsed) errorPayload = parsed;
        }
      }

      const wasNew = !state.currentId;
      if (errorPayload) {
        mdBox.innerHTML = acc ? window.FlashMD.render(acc) : '';
        mdBox.appendChild(errorBanner(`${errorPayload.code} ${errorPayload.message}${errorPayload.hint ? ` — ${errorPayload.hint}` : ''}`));
        state.messages.push({
          id: errorPayload.messageId || Date.now(), role: 'assistant', content: acc,
          error: `${errorPayload.code} ${errorPayload.message}`, created_at: new Date().toISOString(),
        });
        if (errorPayload.code === 'insufficient_credits' || errorPayload.code === 'invalid_api_key' || errorPayload.code === 'no_api_key') {
          $('#aiPill').className = 'pill bad';
          $('#aiPillText').textContent = 'AI unavailable';
        }
      } else if (donePayload) {
        mdBox.innerHTML = window.FlashMD.render(donePayload.content || acc);
        const actions = el('div', 'msg-actions show');
        actions.innerHTML = live.querySelector('.msg-actions')?.innerHTML || '';
        const existingActions = live.querySelector('.msg-actions');
        if (existingActions) existingActions.classList.add('show');
        state.messages.push({
          id: donePayload.messageId, role: 'assistant', content: donePayload.content || acc,
          model: donePayload.model, created_at: new Date().toISOString(),
        });
        if (state.speakEnabled && (donePayload.content || acc)) speakMessage(donePayload.content || acc);
        newConvId = donePayload.conversationId || state.currentId;
      }

      if (wasNew || newConvId) {
        await loadConversations();
        if (!state.currentId) {
          const first = state.conversations[0];
          if (first) state.currentId = first.id;
          renderConversations();
        }
      }
      loadStatus();
      scrollBottom(true);
    } catch (err) {
      if (err.name === 'AbortError') {
        mdBox.innerHTML = window.FlashMD.render(acc) + (acc ? '' : '<span style="color:var(--text-mute)">Stopped.</span>');
        if (acc) state.messages.push({ id: Date.now(), role: 'assistant', content: acc, created_at: new Date().toISOString() });
      } else {
        mdBox.innerHTML = '';
        mdBox.appendChild(errorBanner(`${err.code || 'error'} ${err.message}${err.hint ? ' — ' + err.hint : ''}`));
        if (err.code === 'daily_limit_reached') updateQuotaHint(true);
      }
    } finally {
      live.querySelector('.msg-actions')?.classList.add('show');
      state.controller = null;
      setStreaming(false);
      loadStatus();
      loadMemories();
    }
  }

  function updateQuotaHint(limited) {
    if (state.dailyLimit && state.dailyUsed !== null) {
      $('#quotaHint').textContent = `${Math.max(0, state.dailyLimit - state.dailyUsed)} of ${state.dailyLimit} messages left today`;
    } else if (limited) {
      $('#quotaHint').textContent = 'Daily message limit reached';
    } else {
      $('#quotaHint').textContent = 'Arabic · English · Libyan dialect';
    }
  }
  updateQuotaHint();

  /* ─────────────── voice ─────────────── */

  async function loadVoices() {
    try {
      const r = await fetch('/api/voice/voices');
      if (r.ok) {
        const d = await r.json();
        state.voices = d.voices || [];
      }
    } catch { /* not signed in yet */ }
  }

  function speakMessage(text) {
    if (!text) return;
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/[#*_`>|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3500);
    fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: clean, voice: state.voice || undefined, speed: state.speed }),
    }).then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.message || 'Text-to-speech failed.');
      }
      return r.blob();
    }).then((blob) => {
      const audio = new Audio(URL.createObjectURL(blob));
      audio.playbackRate = state.speed;
      audio.play().catch(() => {});
      audio.onended = () => { if (voiceMode.on) startRecording(); };
    }).catch((e) => toast(e.message, 'err'));
  }

  function updateSpeakToggle() {
    $('#speakToggle').classList.toggle('active', state.speakEnabled);
    $('#speakToggle').title = state.speakEnabled ? 'Read replies aloud: on' : 'Read replies aloud: off';
  }
  $('#speakToggle').addEventListener('click', () => {
    state.speakEnabled = !state.speakEnabled;
    localStorage.setItem('fa_speak', state.speakEnabled ? '1' : '0');
    updateSpeakToggle();
    toast(state.speakEnabled ? 'Replies will be read aloud' : 'Read-aloud off', 'ok');
  });

  const voiceMode = { on: false };

  let recorder = null;
  let chunks = [];

  async function startRecording() {
    if (recorder) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      chunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        recorder = null;
        $('#micBtn').classList.remove('rec');
        if (blob.size < 1200) return;
        $('#micBtn').classList.add('rec');
        try {
          const res = await fetch('/api/voice/transcribe?language=auto', {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            credentials: 'same-origin',
            body: blob,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'Transcription failed.');
          if (data.text) {
            const input = $('#input');
            input.value = (input.value ? input.value + ' ' : '') + data.text;
            autoGrow();
            input.focus();
            if (voiceMode.on) send();
          }
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          $('#micBtn').classList.remove('rec');
        }
      };
      recorder.start();
      $('#micBtn').classList.add('rec');
    } catch (e) {
      toast('Microphone unavailable: ' + e.message, 'err');
    }
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  $('#micBtn').addEventListener('click', () => {
    if (recorder) stopRecording(); else startRecording();
  });

  $('#voiceBtn').addEventListener('click', openVoiceModal);

  function openVoiceModal() {
    const opts = state.voices.length ? state.voices
      : [{ id: 'alloy', label: 'Alloy' }, { id: 'nova', label: 'Nova' }, { id: 'echo', label: 'Echo' }];
    modal({
      title: 'Flash Voice',
      body: `
        <p class="sub">Speech recognition understands Arabic, English and Libyan dialect. Choose the reading voice below.</p>
        <div class="field"><label>Voice</label>
          <select class="select" id="mVoice">${opts.map((v) =>
            `<option value="${esc(v.id)}"${v.id === (state.voice || state.config.tts_voice) ? ' selected' : ''}>${esc(v.label || v.id)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Speaking speed — <span id="mSpeedVal">${state.speed.toFixed(1)}×</span></label>
          <input type="range" id="mSpeed" min="0.6" max="1.6" step="0.1" value="${state.speed}" style="width:100%;accent-color:#4d8dff">
        </div>
        <div class="field" style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" id="mAuto" ${state.speakEnabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:#4d8dff">
          <label style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text)">Read replies aloud automatically</label>
        </div>
        <div class="field" style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" id="mVoiceMode" ${voiceMode.on ? 'checked' : ''} style="width:16px;height:16px;accent-color:#4d8dff">
          <label style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text)">Voice conversation mode (mic reopens after each reply)</label>
        </div>
        <button class="btn" id="mTest" style="width:100%">▶ Test this voice</button>`,
      actions: [{ label: 'Done', cls: 'primary', onClick: async (root) => {
        state.voice = root.querySelector('#mVoice').value;
        state.speed = parseFloat(root.querySelector('#mSpeed').value);
        state.speakEnabled = root.querySelector('#mAuto').checked;
        voiceMode.on = root.querySelector('#mVoiceMode').checked;
        localStorage.setItem('fa_voice', state.voice);
        localStorage.setItem('fa_speed', String(state.speed));
        localStorage.setItem('fa_speak', state.speakEnabled ? '1' : '0');
        updateSpeakToggle();
        toast('Voice settings saved', 'ok');
      } }],
      onMount: (root) => {
        root.querySelector('#mSpeed').addEventListener('input', (e) => {
          root.querySelector('#mSpeedVal').textContent = Number(e.target.value).toFixed(1) + '×';
        });
        root.querySelector('#mTest').addEventListener('click', () => {
          const v = root.querySelector('#mVoice').value;
          const sp = parseFloat(root.querySelector('#mSpeed').value);
          const saved = { voice: state.voice, speed: state.speed };
          state.voice = v; state.speed = sp;
          speakMessage('مرحبا، أنا فلاش. صوتي واضح؟ Hello, I am FLASH.');
          state.voice = saved.voice; state.speed = saved.speed;
        });
      },
    });
  }

  /* ─────────────── memory ─────────────── */

  let memoryCache = [];

  async function loadMemories() {
    try {
      const { memories } = await api('/api/memories');
      memoryCache = memories;
      $('#memCount').textContent = String(memories.length);
    } catch { /* ignore */ }
  }

  $('#memoryBtn').addEventListener('click', openMemoryModal);

  function openMemoryModal() {
    const m = modal({
      title: 'Flash Memory',
      body: `
        <p class="sub">Facts FLASH keeps about you across conversations. You control every entry — delete anything at any time.</p>
        <div id="memList"></div>
        <div class="field" style="margin-top:14px"><label>Add a memory</label>
          <div style="display:flex;gap:8px">
            <input class="input" id="memNew" placeholder="e.g. I prefer answers in Libyan Arabic">
            <button class="btn" id="memAdd">Add</button>
          </div>
        </div>
        <button class="btn ghost" id="memSuggest" style="width:100%;margin-top:6px">✨ Suggest memories from this conversation</button>`,
      actions: [{ label: 'Close', cls: 'primary' }],
      onMount: async (root) => {
        const list = root.querySelector('#memList');
        const draw = () => {
          list.innerHTML = memoryCache.length ? '' : '<p class="sub" style="margin:0">No memories yet.</p>';
          memoryCache.forEach((mem) => {
            const n = el('div', 'mem-item',
              `<div class="m">${esc(mem.content)}<div class="src">${esc(mem.source)} · ${esc((mem.created_at || '').slice(0, 10))}</div></div>
               <button class="icon-btn danger" title="Delete">✕</button>`);
            n.querySelector('button').addEventListener('click', async () => {
              await api(`/api/memories/${mem.id}`, { method: 'DELETE' });
              memoryCache = memoryCache.filter((x) => x.id !== mem.id);
              $('#memCount').textContent = String(memoryCache.length);
              draw();
            });
            list.appendChild(n);
          });
        };
        draw();
        root.querySelector('#memAdd').addEventListener('click', async () => {
          const input = root.querySelector('#memNew');
          const content = input.value.trim();
          if (!content) return;
          try {
            const { memory } = await api('/api/memories', { method: 'POST', body: { content } });
            memoryCache.unshift(memory);
            input.value = '';
            $('#memCount').textContent = String(memoryCache.length);
            draw();
            toast('Memory saved', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        });
        root.querySelector('#memSuggest').addEventListener('click', async (e) => {
          if (!state.currentId) { toast('Open a conversation first', 'err'); return; }
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = 'Thinking…';
          try {
            const { suggestions } = await api('/api/memories/suggest', { method: 'POST', body: { conversationId: state.currentId } });
            if (!suggestions.length) { toast('Nothing new worth remembering', ''); return; }
            suggestions.forEach((s) => {
              const n = el('div', 'mem-item',
                `<div class="m">${esc(s)}<div class="src">suggested</div></div><button class="btn" style="padding:5px 10px;font-size:12px">Save</button>`);
              n.querySelector('button').addEventListener('click', async () => {
                const { memory } = await api('/api/memories', { method: 'POST', body: { content: s } });
                memoryCache.unshift(memory);
                $('#memCount').textContent = String(memoryCache.length);
                n.remove();
                toast('Saved to memory', 'ok');
              });
              list.prepend(n);
            });
          } catch (err) { toast(err.message, 'err'); }
          finally { btn.disabled = false; btn.textContent = '✨ Suggest memories from this conversation'; }
        });
      },
    });
    return m;
  }

  /* ─────────────── account ─────────────── */

  $('#accountBtn').addEventListener('click', () => openPasswordModal(false));

  function openPasswordModal(forced) {
    const m = modal({
      title: forced ? 'Change your password' : 'Account',
      body: `
        ${forced ? '<div class="banner warn"><div><b>Password change required</b>Your account is using an initial password. Set a new one to continue.</div></div>' : ''}
        <p class="sub">Signed in as <b style="color:var(--text)">${esc(state.user?.username || '')}</b>${state.user?.role === 'admin' ? ' · administrator' : ''}</p>
        <div class="field"><label>Current password</label><input class="input" id="pwCur" type="password" autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input class="input" id="pwNew" type="password" autocomplete="new-password"></div>
        <div class="field"><label>Confirm new password</label><input class="input" id="pwNew2" type="password" autocomplete="new-password"></div>
        <p class="sub" style="margin:0">At least 8 characters, with letters and numbers.</p>`,
      dismissible: !forced,
      actions: forced
        ? [{ label: 'Update password', cls: 'primary', onClick: submitPassword }]
        : [{ label: 'Cancel', cls: 'ghost' }, { label: 'Update password', cls: 'primary', onClick: submitPassword }],
    });
    return m;
  }

  async function submitPassword(root) {
    const cur = root.querySelector('#pwCur').value;
    const a = root.querySelector('#pwNew').value;
    const b = root.querySelector('#pwNew2').value;
    if (a !== b) { toast('The new passwords do not match', 'err'); return false; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: a } });
      toast('Password updated', 'ok');
      state.user.must_change_password = false;
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  /* ─────────────── layout ─────────────── */

  function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.remove('hidden'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); }
  $('#hamburger').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  /* ─────────────── modal engine ─────────────── */

  function modal({ title, body, actions = [], dismissible = true, onMount }) {
    const back = el('div', 'modal-back');
    const box = el('div', 'modal');
    box.innerHTML = `<h3>${esc(title)}</h3>${body}`;
    const acts = el('div', 'modal-actions');
    const close = () => back.remove();

    actions.forEach((a) => {
      const b = el('button', `btn ${a.cls || ''}`, esc(a.label));
      b.addEventListener('click', async () => {
        if (a.onClick) {
          b.disabled = true;
          try {
            const res = await a.onClick(box);
            if (res === false) return;
          } catch (e) { toast(e.message, 'err'); return; }
          finally { b.disabled = false; }
        }
        close();
      });
      acts.appendChild(b);
    });
    if (actions.length) box.appendChild(acts);
    back.appendChild(box);
    back.addEventListener('click', (e) => { if (e.target === back && dismissible) close(); });
    document.addEventListener('keydown', function esc2(e) {
      if (e.key === 'Escape' && dismissible) { close(); document.removeEventListener('keydown', esc2); }
    });
    $('#modalRoot').appendChild(back);
    if (onMount) onMount(box);
    return { close, box };
  }

  /* ─────────────── start ─────────────── */

  boot().catch((e) => {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="banner" style="position:fixed;top:10px;left:10px;right:10px;z-index:99"><div>
        <b>Cannot reach the FLASH AGENT server</b>${esc(e.message)}</div></div>`);
  });
})();

