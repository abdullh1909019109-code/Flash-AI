/* ══════════════════════════════════════════════════════════
   FLASH AGENT — Control Center client
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { admin: null, overview: null, providers: [], presets: {}, settings: {}, view: 'overview', analyticsDays: 14 };

  const TITLES = {
    overview: ['Overview', 'Live state of the FLASH AGENT platform'],
    config: ['AI Configuration', 'The engine that powers every conversation'],
    providers: ['AI Providers', 'OpenAI · Gemini · xAI · custom OpenAI-compatible endpoints'],
    personality: ['AI Personality', 'Name, tone, language and response style'],
    users: ['User Management', 'Accounts, access and suspension'],
    analytics: ['Analytics', 'Requests, tokens, cost and errors'],
    settings: ['General Settings', 'Branding, registration and maintenance'],
  };

  /* ─────── api ─────── */
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* noop */ }
    if (!res.ok) {
      const e = new Error((data && data.message) || `Request failed (${res.status})`);
      e.code = data && data.error; e.hint = data && data.hint;
      if (res.status === 401 || res.status === 403) {
        if (data && data.error === 'password_change_required') openForcePassword();
        else if (!state.admin) showLogin();
      }
      throw e;
    }
    return data;
  }

  function toast(msg, kind = '') {
    const n = document.createElement('div');
    n.className = `toast ${kind}`;
    n.textContent = msg;
    $('#toasts').appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'all .3s'; }, 3400);
    setTimeout(() => n.remove(), 3800);
  }

  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function usd(n) { const v = Number(n || 0); return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`; }
  function bytes(kb) { return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`; }

  /* ─────── auth ─────── */
  function showLogin() {
    $('#adminApp').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
  }
  async function enterAdmin(admin) {
    state.admin = admin;
    $('#loginScreen').classList.add('hidden');
    $('#adminApp').classList.remove('hidden');
    $('#adminName').textContent = admin.username;
    $('#adminAvatar').textContent = admin.username.slice(0, 1).toUpperCase();
    if (admin.must_change_password) openForcePassword();
    await loadOverview();
    render();
  }

  $('#adminLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const { admin } = await api('/api/admin/login', { method: 'POST', body: {
        username: $('#aUser').value.trim(), password: $('#aPass').value,
      } });
      await enterAdmin(admin);
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Sign in to Control Center'; }
  });

  $('#adminLogout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  function openForcePassword() {
    modal({
      title: 'Set a new administrator password',
      dismissible: false,
      body: `<div class="banner warn"><div><b>Initial password detected</b>
        The deployment password must be replaced before the dashboard can be used. Never keep the default password.</div></div>
        <div class="field"><label>Current password</label><input class="input" id="fCur" type="password"></div>
        <div class="field"><label>New password</label><input class="input" id="fNew" type="password"></div>
        <div class="field"><label>Confirm new password</label><input class="input" id="fNew2" type="password"></div>
        <p class="sub" style="margin:0">At least 8 characters with letters and numbers.</p>`,
      actions: [{ label: 'Update password', cls: 'primary', onClick: async (root) => {
        const a = root.querySelector('#fNew').value;
        if (a !== root.querySelector('#fNew2').value) { toast('Passwords do not match', 'err'); return false; }
        try {
          await api('/api/admin/change-password', { method: 'POST', body: {
            currentPassword: root.querySelector('#fCur').value, newPassword: a,
          } });
        } catch (e) { toast(e.message, 'err'); return false; }
        state.admin.must_change_password = false;
        toast('Password updated', 'ok');
        return true;
      } }],
    });
  }

  /* ─────── shell ─────── */
  $$('.rail-item').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    $$('.rail-item').forEach((x) => x.classList.toggle('active', x === b));
    $('.admin-rail').classList.remove('open');
    render();
  }));
  const railToggle = document.getElementById('railToggle');
  if (railToggle) railToggle.addEventListener('click', () => document.querySelector('.admin-rail').classList.toggle('open'));

  $('#refreshBtn').addEventListener('click', async () => { await loadOverview(); render(); toast('Refreshed', 'ok'); });

  function render() {
    const [t, s] = TITLES[state.view];
    $('#viewTitle').textContent = t;
    $('#viewSub').textContent = s;
    const body = $('#adminBody');
    body.scrollTop = 0;
    const fn = {
      overview: viewOverview, config: viewConfig, providers: viewProviders,
      personality: viewPersonality, users: viewUsers, analytics: viewAnalytics, settings: viewSettings,
    }[state.view];
    body.innerHTML = '';
    fn(body);
    updateConnPill();
  }

  function updateConnPill() {
    const o = state.overview;
    const pill = $('#connPill');
    if (!o) return;
    pill.className = 'pill';
    if (o.ai.configured) {
      pill.classList.add('ok');
      $('#connText').textContent = `${o.ai.provider} · ${o.ai.model}`;
    } else {
      pill.classList.add('bad');
      $('#connText').textContent = 'AI not configured';
    }
  }

  async function loadOverview() {
    const o = await api('/api/admin/overview');
    state.overview = o;
    state.settings = o.settings;
    const p = await api('/api/admin/providers');
    state.providers = p.providers;
    state.presets = p.presets;
    updateConnPill();
  }

  /* ═════════ VIEW: OVERVIEW ═════════ */
  function viewOverview(root) {
    const o = state.overview;
    if (!o) { root.innerHTML = '<div class="empty">Loading…</div>'; return; }
    const s = o.stats;

    root.innerHTML = `
      ${o.ai.configured ? '' : `<div class="banner"><div><b>The AI engine has no API key</b>
        No conversation can be answered until an API key is set.
        <a href="#" data-goto="config" style="color:#fff;text-decoration:underline">Open AI Configuration →</a></div></div>`}

      <div class="grid k4">
        ${kpi('Total users', fmt(s.users), `${fmt(s.active_users_7d)} active in 7 days`, '')}
        ${kpi('Conversations', fmt(s.conversations), `${fmt(s.messages)} messages`, 'p')}
        ${kpi('Requests today', fmt(s.today_requests), `${fmt(s.today_tokens)} tokens`, 'g')}
        ${kpi('Estimated cost today', usd(s.today_cost), `${usd(s.month_cost)} in 30 days`, 'w')}
      </div>

      <div class="grid k2" style="margin-top:14px">
        <div class="panel">
          <h2>AI engine</h2>
          <p class="hint">The provider that answers every message right now</p>
          <div class="kv">
            <span class="k">Provider</span><span class="v">${esc(o.ai.provider || '—')}</span>
            <span class="k">Active model</span><span class="v mono">${esc(o.ai.model || '—')}</span>
            <span class="k">Base URL</span><span class="v mono" style="font-size:11px">${esc(o.ai.base_url || '—')}</span>
            <span class="k">API key</span><span class="v mono">${o.ai.has_key ? esc(o.ai.key_masked) : '<span class="badge bad">missing</span>'}</span>
            <span class="k">Status</span><span class="v">${o.ai.configured ? '<span class="badge ok">ready</span>' : '<span class="badge bad">not configured</span>'}</span>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn" id="ovTest">Test connection</button>
            <button class="btn primary" data-goto="config">Configure</button>
          </div>
          <div id="ovTestOut" style="margin-top:12px"></div>
        </div>

        <div class="panel">
          <h2>Platform</h2>
          <p class="hint">Runtime health of this deployment</p>
          <div class="kv">
            <span class="k">Version</span><span class="v">${esc(o.server.version)}</span>
            <span class="k">Uptime</span><span class="v">${Math.floor(o.server.uptime_seconds / 60)} min</span>
            <span class="k">Node.js</span><span class="v">${esc(o.server.node)}</span>
            <span class="k">Memory RSS</span><span class="v">${o.server.memory_mb} MB</span>
            <span class="k">Database</span><span class="v">${bytes(o.server.db_size_kb)}</span>
            <span class="k">Platform</span><span class="v">${esc(o.server.platform)}</span>
            <span class="k">Errors (24h)</span><span class="v">${s.errors_24h > 0 ? `<span class="badge bad">${fmt(s.errors_24h)}</span>` : '<span class="badge ok">0</span>'}</span>
          </div>
        </div>
      </div>

      <div class="grid k3" style="margin-top:14px">
        ${miniStat('Memories stored', fmt(s.memories), 'Flash Memory entries')}
        ${miniStat('Suspended accounts', fmt(s.suspended), 'blocked from signing in')}
        ${miniStat('Administrators', fmt(s.admins), 'with dashboard access')}
      </div>`;

    root.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const view = a.dataset.goto;
      const btn = $(`.rail-item[data-view="${view}"]`);
      if (btn) btn.click();
    }));

    const testBtn = $('#ovTest', root);
    if (testBtn) testBtn.addEventListener('click', async () => {
      const out = $('#ovTestOut', root);
      testBtn.disabled = true; testBtn.textContent = 'Testing…';
      out.innerHTML = '';
      try {
        const r = await api('/api/admin/test-connection', { method: 'POST', body: {} });
        out.innerHTML = resultBox(r);
      } catch (e) { out.innerHTML = `<div class="banner"><div><b>Test failed</b>${esc(e.message)}</div></div>`; }
      finally { testBtn.disabled = false; testBtn.textContent = 'Test connection'; }
    });
  }

  const kpi = (label, value, sub, tone) => `
    <div class="panel kpi ${tone}"><div class="accent"></div>
      <div class="label">${esc(label)}</div>
      <div class="value">${value}</div>
      <div class="sub">${esc(sub)}</div>
    </div>`;

  const miniStat = (label, value, sub) => `
    <div class="panel"><div class="label" style="font-size:10.4px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-mute);font-weight:700">${esc(label)}</div>
      <div style="font-size:20px;font-weight:800;margin:6px 0 2px">${value}</div>
      <div class="muted" style="font-size:11.6px">${esc(sub)}</div></div>`;

  function resultBox(r) {
    const ok = r.ok;
    return `<div class="banner ${ok ? 'info' : ''}" style="${ok ? 'background:rgba(55,217,154,.1);border-color:rgba(55,217,154,.35);color:#a9f2d3' : ''}">
      <div><b>${ok ? 'Connection verified' : 'Connection problem'}${r.ms ? ` · ${r.ms} ms` : ''}</b>
      ${esc(r.message || '')}
      ${r.hint ? `<div style="margin-top:5px;opacity:.85">${esc(r.hint)}</div>` : ''}
      ${r.code ? `<div style="margin-top:5px"><code>${esc(r.code)}</code></div>` : ''}
      ${r.models && r.models.length ? `<div style="margin-top:7px;font-size:11.5px;opacity:.8">Models visible: ${r.models.slice(0, 12).map(esc).join(', ')}${r.models.length > 12 ? '…' : ''}</div>` : ''}
      </div></div>`;
  }

  /* ═════════ VIEW: AI CONFIGURATION ═════════ */
  function viewConfig(root) {
    const active = state.providers.find((p) => p.active) || state.providers[0];
    const p = active || { kind: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 2048, api_key_masked: '', has_key: false, models: [] };

    root.innerHTML = `
      <div class="panel">
        <h2>Active connection</h2>
        <p class="hint">Changes here take effect on the very next message — no restart, no code edit.</p>
        <div class="form-grid">
          <div class="field">
            <label>Provider type</label>
            <select class="select" id="cKind">
              ${Object.entries(state.presets).map(([k, v]) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
            </select>
            <div class="help">Choosing a type fills its default base URL and models.</div>
          </div>
          <div class="field"><label>Display name</label><input class="input" id="cName" value="${esc(p.name)}"></div>
          <div class="field full"><label>API base URL</label><input class="input mono" id="cBase" value="${esc(p.base_url)}" placeholder="https://api.openai.com/v1"></div>
          <div class="field full">
            <label>API key ${p.has_key ? `<span class="badge ok" style="margin-left:6px">stored</span>` : '<span class="badge bad" style="margin-left:6px">missing</span>'}</label>
            <div class="copy-row">
              <input class="input mono" id="cKey" type="password" autocomplete="new-password"
                placeholder="${p.has_key ? esc(p.api_key_masked) + ' — leave blank to keep the stored key' : 'sk-…'}">
              <button class="btn ghost" id="cKeyShow" type="button">Show</button>
            </div>
            <div class="help">Stored encrypted (AES-256-GCM) on the server. It is never sent to a browser again.</div>
          </div>
          <div class="field">
            <label>Model</label>
            <input class="input mono" id="cModel" value="${esc(p.model)}" list="modelList">
            <datalist id="modelList">${(p.models || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
          </div>
          <div class="field">
            <label>Temperature — <span id="cTempVal">${Number(p.temperature).toFixed(2)}</span></label>
            <input type="range" id="cTemp" min="0" max="2" step="0.05" value="${p.temperature}" style="width:100%;accent-color:#4d8dff">
            <div class="help">0 = deterministic · 1 = balanced · 2 = wild</div>
          </div>
          <div class="field">
            <label>Maximum tokens</label>
            <input class="input" id="cMax" type="number" min="64" max="32768" step="64" value="${p.max_tokens}">
          </div>
        </div>
        <div class="row" style="margin-top:16px">
          <button class="btn" id="cTest">Test connection</button>
          <button class="btn primary" id="cSave">Save configuration</button>
          <button class="btn ghost" id="cActivate">${p.active ? '✓ Active provider' : 'Activate this provider'}</button>
        </div>
        <div id="cOut" style="margin-top:14px"></div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h2>Presets</h2>
        <p class="hint">Every provider below speaks the OpenAI chat-completions format, so switching is instant.</p>
        <div class="grid k2">
          ${Object.entries(state.presets).map(([k, v]) => `
            <div class="panel" style="background:rgba(255,255,255,.02)">
              <div class="row" style="justify-content:space-between">
                <b style="font-size:13px">${esc(v.name)}</b>
                <button class="btn ghost" data-preset="${k}" style="padding:5px 11px;font-size:12px">Use</button>
              </div>
              <div class="mono muted" style="font-size:11px;margin-top:6px;word-break:break-all">${esc(v.base_url)}</div>
              <div class="muted" style="font-size:11px;margin-top:4px">${v.models.join(' · ')}</div>
            </div>`).join('')}
        </div>
      </div>`;

    const kindSel = $('#cKind', root);
    kindSel.addEventListener('change', () => {
      const preset = state.presets[kindSel.value];
      if (!preset) return;
      $('#cName', root).value = preset.name;
      $('#cBase', root).value = preset.base_url;
      $('#cModel', root).value = preset.models[0];
      $('#modelList', root).innerHTML = preset.models.map((m) => `<option value="${esc(m)}">`).join('');
    });

    $('#cTemp', root).addEventListener('input', (e) => {
      $('#cTempVal', root).textContent = Number(e.target.value).toFixed(2);
    });

    $('#cKeyShow', root).addEventListener('click', () => {
      const i = $('#cKey', root);
      i.type = i.type === 'password' ? 'text' : 'password';
      $('#cKeyShow', root).textContent = i.type === 'password' ? 'Show' : 'Hide';
    });

    const collect = () => ({
      kind: kindSel.value,
      name: $('#cName', root).value.trim(),
      base_url: $('#cBase', root).value.trim(),
      api_key: $('#cKey', root).value.trim(),
      model: $('#cModel', root).value.trim(),
      temperature: parseFloat($('#cTemp', root).value),
      max_tokens: parseInt($('#cMax', root).value, 10),
    });

    $('#cTest', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; const out = $('#cOut', root);
      btn.disabled = true; btn.textContent = 'Testing…'; out.innerHTML = '';
      try {
        const body = collect();
        const r = await api('/api/admin/test-connection', { method: 'POST', body: {
          id: active ? active.id : undefined,
          base_url: body.base_url, api_key: body.api_key || undefined, model: body.model, name: body.name,
        } });
        out.innerHTML = resultBox(r);
      } catch (err) { out.innerHTML = `<div class="banner"><div><b>Test failed</b>${esc(err.message)}</div></div>`; }
      finally { btn.disabled = false; btn.textContent = 'Test connection'; }
    });

    $('#cSave', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; const out = $('#cOut', root);
      const body = collect();
      if (!body.base_url) { toast('API base URL is required', 'err'); return; }
      if (!body.model) { toast('Model is required', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (active) {
          await api(`/api/admin/providers/${active.id}`, { method: 'PATCH', body });
        } else {
          const { provider } = await api('/api/admin/providers', { method: 'POST', body });
          await api(`/api/admin/providers/${provider.id}/activate`, { method: 'POST' });
        }
        await loadOverview();
        toast('Configuration saved and live', 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = 'Save configuration'; }
    });

    $('#cActivate', root).addEventListener('click', async () => {
      if (!active) { toast('Save the configuration first', 'err'); return; }
      await api(`/api/admin/providers/${active.id}/activate`, { method: 'POST' });
      await loadOverview();
      toast('Provider activated', 'ok');
      render();
    });

    root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.preset;
      kindSel.value = k;
      kindSel.dispatchEvent(new Event('change'));
    }));
  }

  /* ═════════ VIEW: PROVIDERS ═════════ */
  function viewProviders(root) {
    root.innerHTML = `
      <div class="panel">
        <h2>Configured providers</h2>
        <p class="hint">Exactly one provider is active at a time. Add several and switch instantly.</p>
        <table class="tbl">
          <thead><tr><th>Provider</th><th>Type</th><th>Endpoint</th><th>Model</th><th>Key</th><th>State</th><th></th></tr></thead>
          <tbody>
            ${state.providers.length ? state.providers.map((p) => `
              <tr>
                <td><b>${esc(p.name)}</b></td>
                <td><span class="badge blue">${esc(p.kind)}</span></td>
                <td class="mono muted" style="font-size:11px">${esc(p.base_url)}</td>
                <td class="mono">${esc(p.model)}</td>
                <td>${p.has_key ? `<span class="mono">${esc(p.api_key_masked)}</span>` : '<span class="badge bad">none</span>'}</td>
                <td>${p.active ? '<span class="badge ok">active</span>' : `<span class="badge">${p.enabled ? 'idle' : 'disabled'}</span>`}</td>
                <td style="text-align:right;white-space:nowrap">
                  ${p.active ? '' : `<button class="btn ghost" data-act="activate" data-id="${p.id}" style="padding:4px 9px;font-size:11.5px">Activate</button>`}
                  <button class="btn ghost" data-act="test" data-id="${p.id}" style="padding:4px 9px;font-size:11.5px">Test</button>
                  <button class="btn danger" data-act="del" data-id="${p.id}" style="padding:4px 9px;font-size:11.5px">Delete</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="7"><div class="empty">No providers configured yet.</div></td></tr>'}
          </tbody>
        </table>
        <div id="pOut" style="margin-top:12px"></div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h2>Add a provider</h2>
        <p class="hint">Any OpenAI-compatible endpoint works — local models, aggregators, or your own gateway.</p>
        <div class="form-grid">
          <div class="field"><label>Type</label>
            <select class="select" id="nKind">${Object.entries(state.presets).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Name</label><input class="input" id="nName" placeholder="OpenAI production"></div>
          <div class="field full"><label>API base URL</label><input class="input mono" id="nBase" placeholder="https://api.openai.com/v1"></div>
          <div class="field full"><label>API key</label><input class="input mono" id="nKey" type="password" placeholder="sk-…"></div>
          <div class="field"><label>Model</label><input class="input mono" id="nModel" placeholder="gpt-4o-mini"></div>
          <div class="field"><label>Max tokens</label><input class="input" id="nMax" type="number" value="2048" min="64" max="32768"></div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="nAdd">Add provider</button>
        </div>
      </div>`;

    const kindSel = $('#nKind', root);
    kindSel.addEventListener('change', () => {
      const preset = state.presets[kindSel.value];
      $('#nName', root).value = preset.name;
      $('#nBase', root).value = preset.base_url;
      $('#nModel', root).value = preset.models[0];
    });
    kindSel.dispatchEvent(new Event('change'));

    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      const act = b.dataset.act;
      const p = state.providers.find((x) => x.id === id);
      const out = $('#pOut', root);
      try {
        if (act === 'activate') {
          await api(`/api/admin/providers/${id}/activate`, { method: 'POST' });
          await loadOverview(); toast('Provider activated', 'ok'); render();
        }
        if (act === 'test') {
          b.disabled = true; b.textContent = '…';
          const r = await api('/api/admin/test-connection', { method: 'POST', body: { id } });
          out.innerHTML = resultBox(r);
          b.disabled = false; b.textContent = 'Test';
        }
        if (act === 'del') {
          if (!confirm(`Delete provider “${p.name}”? Conversations are unaffected.`)) return;
          await api(`/api/admin/providers/${id}`, { method: 'DELETE' });
          await loadOverview(); toast('Provider deleted', 'ok'); render();
        }
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Test'; }
    }));

    $('#nAdd', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const body = {
        kind: kindSel.value,
        name: $('#nName', root).value.trim() || state.presets[kindSel.value].name,
        base_url: $('#nBase', root).value.trim(),
        api_key: $('#nKey', root).value.trim(),
        model: $('#nModel', root).value.trim(),
        max_tokens: parseInt($('#nMax', root).value, 10) || 2048,
      };
      if (!body.base_url || !body.model) { toast('Base URL and model are required', 'err'); return; }
      btn.disabled = true;
      try {
        await api('/api/admin/providers', { method: 'POST', body });
        await loadOverview();
        toast('Provider added', 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    });
  }

  /* ═════════ VIEW: PERSONALITY ═════════ */
  function viewPersonality(root) {
    const s = state.settings;
    root.innerHTML = `
      <div class="panel">
        <h2>Identity</h2>
        <p class="hint">How the assistant introduces itself and behaves in every conversation.</p>
        <div class="form-grid">
          <div class="field"><label>AI name</label><input class="input" id="pName" value="${esc(s.ai_name || 'FLASH')}"></div>
          <div class="field"><label>Creativity</label>
            <select class="select" id="pCreativity">
              ${['precise', 'balanced', 'creative'].map((v) => `<option value="${v}"${s.creativity === v ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Response length</label>
            <select class="select" id="pLength">
              ${['short', 'balanced', 'detailed'].map((v) => `<option value="${v}"${s.response_length === v ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Default language</label>
            <select class="select" id="pLang">
              <option value="auto"${s.default_language === 'auto' ? ' selected' : ''}>Mirror the user (auto)</option>
              <option value="ar"${s.default_language === 'ar' ? ' selected' : ''}>Arabic first</option>
              <option value="en"${s.default_language === 'en' ? ' selected' : ''}>English first</option>
            </select>
          </div>
          <div class="field"><label>Arabic dialect</label>
            <select class="select" id="pDialect">
              ${[['libyan', 'Libyan (ليبي)'], ['egyptian', 'Egyptian (مصري)'], ['gulf', 'Gulf (خليجي)'], ['levantine', 'Levantine (شامي)'], ['msa', 'Modern Standard (فصحى)'], ['none', 'No preference']]
                .map(([v, l]) => `<option value="${v}"${s.arabic_dialect === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field full"><label>Personality</label>
            <input class="input" id="pPersona" value="${esc(s.personality || '')}">
          </div>
          <div class="field full"><label>System instructions</label>
            <textarea class="textarea" id="pSystem" rows="7">${esc(s.system_prompt || '')}</textarea>
            <div class="help">This is the core instruction prepended to every request, before memories and mode rules.</div>
          </div>
        </div>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="pSave">Save personality</button></div>
        <div id="pOut" style="margin-top:12px"></div>
      </div>`;

    $('#pSave', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { settings } = await api('/api/admin/settings', { method: 'PUT', body: {
          ai_name: $('#pName', root).value.trim(),
          creativity: $('#pCreativity', root).value,
          response_length: $('#pLength', root).value,
          default_language: $('#pLang', root).value,
          arabic_dialect: $('#pDialect', root).value,
          personality: $('#pPersona', root).value.trim(),
          system_prompt: $('#pSystem', root).value,
        } });
        state.settings = settings;
        toast('Personality saved — live now', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    });
  }

  /* ═════════ VIEW: USERS ═════════ */
  async function viewUsers(root) {
    root.innerHTML = `
      <div class="panel">
        <div class="row" style="justify-content:space-between;margin-bottom:12px">
          <div class="row">
            <input class="input" id="uSearch" placeholder="Search username or email" style="width:250px">
            <button class="btn" id="uSearchBtn">Search</button>
          </div>
          <button class="btn primary" id="uNew">+ New account</button>
        </div>
        <table class="tbl"><thead><tr>
          <th>User</th><th>Role</th><th>Status</th><th class="num">Chats</th><th class="num">Messages</th><th>Joined</th><th>Last login</th><th></th>
        </tr></thead><tbody id="uBody"><tr><td colspan="8"><div class="empty">Loading…</div></td></tr></tbody></table>
      </div>`;

    const load = async (q = '') => {
      try {
        const { users } = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
        const body = $('#uBody', root);
        if (!users.length) { body.innerHTML = '<tr><td colspan="8"><div class="empty">No users found.</div></td></tr>'; return; }
        body.innerHTML = users.map((u) => `
          <tr>
            <td><b>${esc(u.username)}</b><div class="muted" style="font-size:11px">${esc(u.email || '—')}</div></td>
            <td><span class="badge ${u.role === 'admin' ? 'blue' : ''}">${esc(u.role)}</span></td>
            <td>${u.status === 'active' ? '<span class="badge ok">active</span>' : '<span class="badge bad">suspended</span>'}</td>
            <td class="num">${fmt(u.conversations)}</td>
            <td class="num">${fmt(u.messages)}</td>
            <td class="muted" style="font-size:11.5px">${esc((u.created_at || '').slice(0, 10))}</td>
            <td class="muted" style="font-size:11.5px">${esc((u.last_login_at || 'never').slice(0, 16))}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn ghost" data-u="${u.id}" data-act="toggle" style="padding:4px 9px;font-size:11.5px">${u.status === 'active' ? 'Suspend' : 'Activate'}</button>
              <button class="btn ghost" data-u="${u.id}" data-act="reset" style="padding:4px 9px;font-size:11.5px">Reset password</button>
              <button class="btn danger" data-u="${u.id}" data-act="del" style="padding:4px 9px;font-size:11.5px">Delete</button>
            </td>
          </tr>`).join('');

        body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
          const id = Number(b.dataset.u);
          const user = users.find((x) => x.id === id);
          const act = b.dataset.act;
          try {
            if (act === 'toggle') {
              await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status: user.status === 'active' ? 'suspended' : 'active' } });
              toast(user.status === 'active' ? 'User suspended' : 'User activated', 'ok');
              load(q);
            }
            if (act === 'reset') {
              modal({
                title: `Reset password — ${user.username}`,
                body: `<div class="field"><label>New password</label><input class="input" id="rPw" type="password"></div>
                       <p class="sub" style="margin:0">The user is signed out of every session immediately.</p>`,
                actions: [{ label: 'Cancel', cls: 'ghost' }, { label: 'Reset', cls: 'primary', onClick: async (root2) => {
                  const pw = root2.querySelector('#rPw').value;
                  if (pw.length < 8) { toast('Password must be at least 8 characters', 'err'); return false; }
                  try { await api(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: { password: pw } }); }
                  catch (e) { toast(e.message, 'err'); return false; }
                  toast('Password reset', 'ok');
                  return true;
                } }],
              });
            }
            if (act === 'del') {
              if (!confirm(`Delete ${user.username}? All their conversations, messages and memories are removed permanently.`)) return;
              await api(`/api/admin/users/${id}`, { method: 'DELETE' });
              toast('User deleted', 'ok');
              load(q);
            }
          } catch (e) { toast(e.message, 'err'); }
        }));
      } catch (e) {
        $('#uBody', root).innerHTML = `<tr><td colspan="8"><div class="empty">${esc(e.message)}</div></td></tr>`;
      }
    };

    $('#uSearchBtn', root).addEventListener('click', () => load($('#uSearch', root).value.trim()));
    $('#uSearch', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') load($('#uSearch', root).value.trim()); });

    $('#uNew', root).addEventListener('click', () => {
      modal({
        title: 'Create account',
        body: `<div class="field"><label>Username</label><input class="input" id="nUser"></div>
               <div class="field"><label>Email (optional)</label><input class="input" id="nEmail" type="email"></div>
               <div class="field"><label>Password</label><input class="input" id="nPass" type="password"></div>
               <div class="field"><label>Role</label><select class="select" id="nRole"><option value="user">user</option><option value="admin">admin</option></select></div>`,
        actions: [{ label: 'Cancel', cls: 'ghost' }, { label: 'Create', cls: 'primary', onClick: async (root2) => {
          try {
            await api('/api/admin/users', { method: 'POST', body: {
              username: root2.querySelector('#nUser').value.trim(),
              email: root2.querySelector('#nEmail').value.trim() || null,
              password: root2.querySelector('#nPass').value,
              role: root2.querySelector('#nRole').value,
            } });
          } catch (e) { toast(e.message, 'err'); return false; }
          toast('Account created', 'ok');
          load('');
          return true;
        } }],
      });
    });

    load('');
  }

  /* ═════════ VIEW: ANALYTICS ═════════ */
  async function viewAnalytics(root) {
    root.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        ${[7, 14, 30, 90].map((d) => `<button class="btn ${state.analyticsDays === d ? 'primary' : 'ghost'}" data-days="${d}">${d} days</button>`).join('')}
      </div>
      <div id="anBody"><div class="empty">Loading…</div></div>`;

    root.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
      state.analyticsDays = Number(b.dataset.days);
      viewAnalytics(root);
    }));

    try {
      const a = await api(`/api/admin/analytics?days=${state.analyticsDays}`);
      const maxReq = Math.max(1, ...a.daily.map((d) => d.requests));
      const totalReq = a.daily.reduce((s, d) => s + d.requests, 0);
      const totalTok = a.daily.reduce((s, d) => s + d.tokens, 0);
      const totalCost = a.daily.reduce((s, d) => s + d.cost, 0);
      const totalErr = a.daily.reduce((s, d) => s + d.errors, 0);

      $('#anBody', root).innerHTML = `
        <div class="grid k4">
          ${kpi('Requests', fmt(totalReq), `${a.days}-day total`, '')}
          ${kpi('Tokens', fmt(totalTok), `≈ ${fmt(Math.round(totalTok / Math.max(1, totalReq)))} per request`, 'p')}
          ${kpi('Estimated cost', usd(totalCost), 'provider list price', 'g')}
          ${kpi('Errors', fmt(totalErr), totalReq ? `${((totalErr / totalReq) * 100).toFixed(1)}% of requests` : 'none', 'w')}
        </div>

        <div class="panel" style="margin-top:14px">
          <h2>Daily requests</h2>
          <p class="hint">Successful requests in blue, errors in red</p>
          <div class="chart">
            ${a.daily.map((d) => `
              <div class="bar-col" title="${d.day}: ${d.requests} requests, ${fmt(d.tokens)} tokens, ${usd(d.cost)}">
                ${d.errors ? `<div class="bar err" style="height:${Math.max(2, (d.errors / maxReq) * 100)}%"></div>` : ''}
                <div class="bar" style="height:${Math.max(1, (d.requests / maxReq) * 100)}%"></div>
              </div>`).join('')}
          </div>
          <div class="chart-labels"><span>${esc(a.daily[0]?.day || '')}</span><span>${esc(a.daily[a.daily.length - 1]?.day || '')}</span></div>
          <div class="chart-legend"><span><i style="background:#4d74ff"></i>requests</span><span><i style="background:#d33a56"></i>errors</span></div>
        </div>

        <div class="grid k2" style="margin-top:14px">
          <div class="panel">
            <h2>By model</h2>
            <p class="hint">Token consumption per model</p>
            <table class="tbl"><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
              ${a.byModel.length ? a.byModel.map((m) => `<tr><td class="mono">${esc(m.model)}</td><td class="num">${fmt(m.requests)}</td><td class="num">${fmt(m.tokens)}</td><td class="num">${usd(m.cost)}</td></tr>`).join('') : '<tr><td colspan="4"><div class="empty">No data yet.</div></td></tr>'}
            </tbody></table>
          </div>
          <div class="panel">
            <h2>By capability</h2>
            <p class="hint">Chat, vision, speech and transcription</p>
            <table class="tbl"><thead><tr><th>Kind</th><th class="num">Requests</th></tr></thead><tbody>
              ${a.byKind.length ? a.byKind.map((k) => `<tr><td><span class="badge blue">${esc(k.kind)}</span></td><td class="num">${fmt(k.requests)}</td></tr>`).join('') : '<tr><td colspan="2"><div class="empty">No data yet.</div></td></tr>'}
            </tbody></table>
          </div>
        </div>

        <div class="panel" style="margin-top:14px">
          <h2>Recent errors</h2>
          <p class="hint">The last 30 failed or stopped requests, newest first</p>
          <table class="tbl"><thead><tr><th>When</th><th>Kind</th><th>Model</th><th>Error</th></tr></thead><tbody>
            ${a.recentErrors.length ? a.recentErrors.map((e) => `<tr>
              <td class="muted" style="font-size:11.5px">${esc((e.created_at || '').slice(0, 16))}</td>
              <td><span class="badge">${esc(e.kind)}</span></td>
              <td class="mono" style="font-size:11.5px">${esc(e.model || '—')}</td>
              <td class="mono" style="font-size:11.5px;color:#ffb3c0">${esc(e.error || '—')}</td></tr>`).join('') : '<tr><td colspan="4"><div class="empty">No errors — everything is clean.</div></td></tr>'}
          </tbody></table>
        </div>

        <div class="panel" style="margin-top:14px">
          <h2>Most active users</h2>
          <p class="hint">Top accounts by request volume</p>
          <table class="tbl"><thead><tr><th>User</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>
            ${a.topUsers.length ? a.topUsers.map((u) => `<tr><td>${esc(u.username)}</td><td class="num">${fmt(u.requests)}</td><td class="num">${fmt(u.tokens)}</td></tr>`).join('') : '<tr><td colspan="3"><div class="empty">No activity yet.</div></td></tr>'}
          </tbody></table>
        </div>`;
    } catch (e) {
      $('#anBody', root).innerHTML = `<div class="banner"><div><b>Analytics unavailable</b>${esc(e.message)}</div></div>`;
    }
  }

  /* ═════════ VIEW: SETTINGS ═════════ */
  function viewSettings(root) {
    const s = state.settings;
    root.innerHTML = `
      <div class="panel">
        <h2>Branding</h2>
        <p class="hint">Shown across the public app, the sign-in screen and the browser tab.</p>
        <div class="form-grid">
          <div class="field"><label>Application name</label><input class="input" id="sName" value="${esc(s.app_name || '')}"></div>
          <div class="field"><label>Slogan</label><input class="input" id="sSlogan" value="${esc(s.slogan || '')}"></div>
          <div class="field"><label>Logo URL</label><input class="input mono" id="sLogo" value="${esc(s.logo_url || '/assets/logo.svg')}"></div>
          <div class="field"><label>Theme</label>
            <select class="select" id="sTheme">
              <option value="midnight"${s.theme === 'midnight' ? ' selected' : ''}>Midnight (black / navy)</option>
              <option value="electric"${s.theme === 'electric' ? ' selected' : ''}>Electric (blue / purple)</option>
            </select>
          </div>
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="sBrandSave">Save branding</button></div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h2>Access</h2>
        <p class="hint">Who can create an account, and whether the app is open</p>
        <div class="switch-row">
          <div class="txt"><b>Public registration</b><span>Allow new users to sign up from the app</span></div>
          <label class="switch"><input type="checkbox" id="sReg" ${s.registration_enabled === 'true' ? 'checked' : ''}><i></i></label>
        </div>
        <div class="switch-row">
          <div class="txt"><b>Maintenance mode</b><span>Visitors see a maintenance page; administrators keep full access</span></div>
          <label class="switch"><input type="checkbox" id="sMaint" ${s.maintenance_mode === 'true' ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field" style="margin-top:14px"><label>Maintenance message</label>
          <input class="input" id="sMaintMsg" value="${esc(s.maintenance_message || '')}">
        </div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h2>Limits &amp; cost model</h2>
        <p class="hint">Used for rate limiting and the cost estimates on the dashboard</p>
        <div class="form-grid">
          <div class="field"><label>Daily messages per user</label><input class="input" id="sDaily" type="number" min="1" value="${esc(s.daily_message_limit || 120)}"></div>
          <div class="field"><label>Requests per minute</label><input class="input" id="sRate" type="number" min="5" value="${esc(s.rate_limit_per_minute || 20)}"></div>
          <div class="field"><label>Max input characters</label><input class="input" id="sMaxChars" type="number" min="500" value="${esc(s.max_input_chars || 12000)}"></div>
          <div class="field"><label>Input price / 1M tokens (USD)</label><input class="input" id="sPin" type="number" step="0.01" value="${esc(s.price_in_per_mtok || 0.15)}"></div>
          <div class="field"><label>Output price / 1M tokens (USD)</label><input class="input" id="sPout" type="number" step="0.01" value="${esc(s.price_out_per_mtok || 0.6)}"></div>
          <div class="field"><label>Vision model</label><input class="input mono" id="sVision" value="${esc(s.vision_model || 'gpt-4o-mini')}"></div>
          <div class="field"><label>Speech-to-text model</label><input class="input mono" id="sStt" value="${esc(s.stt_model || 'whisper-1')}"></div>
          <div class="field"><label>Default TTS voice</label><input class="input mono" id="sVoice" value="${esc(s.tts_voice || 'alloy')}"></div>
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="sSave">Save settings</button></div>
        <div id="sOut" style="margin-top:12px"></div>
      </div>`;

    $('#sBrandSave', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const { settings } = await api('/api/admin/settings', { method: 'PUT', body: {
          app_name: $('#sName', root).value.trim(),
          slogan: $('#sSlogan', root).value.trim(),
          logo_url: $('#sLogo', root).value.trim() || '/assets/logo.svg',
          theme: $('#sTheme', root).value,
        } });
        state.settings = settings;
        toast('Branding saved', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    });

    $('#sSave', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const { settings } = await api('/api/admin/settings', { method: 'PUT', body: {
          registration_enabled: $('#sReg', root).checked,
          maintenance_mode: $('#sMaint', root).checked,
          maintenance_message: $('#sMaintMsg', root).value,
          daily_message_limit: $('#sDaily', root).value,
          rate_limit_per_minute: $('#sRate', root).value,
          max_input_chars: $('#sMaxChars', root).value,
          price_in_per_mtok: $('#sPin', root).value,
          price_out_per_mtok: $('#sPout', root).value,
          vision_model: $('#sVision', root).value.trim(),
          stt_model: $('#sStt', root).value.trim(),
          tts_voice: $('#sVoice', root).value.trim(),
        } });
        state.settings = settings;
        toast('Settings saved', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    });
  }

  /* ─────── modal ─────── */
  function modal({ title, body, actions = [], dismissible = true }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>${body}<div class="modal-actions"></div></div>`;
    const acts = back.querySelector('.modal-actions');
    const close = () => back.remove();
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = `btn ${a.cls || ''}`;
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (a.onClick) {
          b.disabled = true;
          try { const r = await a.onClick(back.querySelector('.modal')); if (r === false) return; }
          catch (e) { toast(e.message, 'err'); return; }
          finally { b.disabled = false; }
        }
        close();
      });
      acts.appendChild(b);
    });
    back.addEventListener('click', (e) => { if (e.target === back && dismissible) close(); });
    $('#modalRoot').appendChild(back);
    return { close };
  }

  /* ─────── boot ─────── */
  (async function boot() {
    try {
      const { admin } = await api('/api/admin/session');
      if (admin) await enterAdmin(admin); else showLogin();
    } catch { showLogin(); }
  })();
})();

