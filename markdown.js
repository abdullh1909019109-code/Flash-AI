/* ══════════════════════════════════════════════════════════
   FLASH AGENT — markdown renderer (no dependencies, XSS-safe)
   Supports headings, lists, tables, quotes, rules, links,
   inline code, bold/italic/strike, and fenced code blocks with
   language label, copy + download buttons and light highlighting.
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const KEYWORDS = {
    js: 'const let var function return if else for while do switch case break continue class new this async await try catch finally throw typeof instanceof extends super import export from default static get set of in null true false undefined void delete yield',
    ts: 'const let var function return if else for while class interface type enum implements extends import export from public private protected readonly async await new this null true false undefined as any string number boolean void',
    python: 'def class return if elif else for while import from as try except finally raise with lambda pass break continue yield global nonlocal assert del in is not and or None True False async await self print',
    php: 'function class return if else elseif foreach for while echo print new public private protected static const use namespace try catch throw extends implements null true false array',
    html: 'html head body div span a p ul li table tr td th form input button script style link meta img h1 h2 h3 section header footer nav main',
    css: 'display flex grid position absolute relative fixed color background border margin padding font width height transition transform animation none block inline',
    sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AND OR NOT NULL PRIMARY KEY DEFAULT',
    go: 'package import func return if else for range var const type struct interface map chan go defer select case switch nil true false',
    rust: 'fn let mut impl struct enum match if else for while loop return use pub mod crate self Self Some None Ok Err true false',
    bash: 'if then else fi for while do done case esac function echo export cd ls sudo curl npm node git return local exit',
  };

  const LANG_ALIASES = {
    javascript: 'js', jsx: 'js', mjs: 'js', node: 'js',
    typescript: 'ts', tsx: 'ts',
    py: 'python', python3: 'python',
    htm: 'html', xml: 'html',
    scss: 'css', sass: 'css',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    json: 'js', yml: 'bash', yaml: 'bash', text: '', txt: '',
  };

  function highlight(code, rawLang) {
    let lang = String(rawLang || '').toLowerCase();
    lang = Object.prototype.hasOwnProperty.call(LANG_ALIASES, lang) ? LANG_ALIASES[lang] : lang;
    const kw = KEYWORDS[lang];
    if (!kw) return escapeHtml(code);

    const kwSet = new Set(kw.split(/\s+/).filter(Boolean));
    // Tokenise in one pass so strings/comments are never double-processed.
    const re = /(\/\/[^\n]*|#[^\n]*|<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      out += escapeHtml(code.slice(last, m.index));
      const [full, com, str, num, word] = m;
      if (com) out += `<span class="tok-com">${escapeHtml(com)}</span>`;
      else if (str) out += `<span class="tok-str">${escapeHtml(str)}</span>`;
      else if (num) out += `<span class="tok-num">${num}</span>`;
      else if (word) {
        if (kwSet.has(word)) out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
        else if (/^[A-Z]/.test(word) && lang !== 'bash') out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
        else out += escapeHtml(word);
      }
      last = m.index + full.length;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function codeBlock(code, lang) {
    const id = 'c' + Math.random().toString(36).slice(2, 9);
    const label = (lang || 'code').replace(/[^a-z0-9+#.-]/gi, '') || 'code';
    return `<div class="code-wrap" data-code-id="${id}">
      <div class="code-head">
        <span class="lang">${escapeHtml(label)}</span>
        <span class="sp"></span>
        <button class="code-btn" data-act="copy-code">Copy</button>
        <button class="code-btn" data-act="download-code" data-lang="${escapeHtml(label)}">Download</button>
      </div>
      <pre><code data-raw="${encodeURIComponent(code)}">${highlight(code, lang)}</code></pre>
    </div>`;
  }

  function inline(text) {
    let s = escapeHtml(text);
    // inline code first (protect its content)
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0000IC${codes.length - 1}\u0000`;
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) =>
      (/^(https?:\/\/|\/)/i.test(src) ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:10px;margin:8px 0">` : escapeHtml(_m)));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, href) =>
      (/^(https?:\/\/|\/|mailto:)/i.test(href)
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${t}</a>`
        : t));
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    s = s.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => `<code class="inline">${codes[Number(i)]}</code>`);
    return s;
  }

  function render(src) {
    if (src === null || src === undefined) return '';
    let text = String(src).replace(/\r\n?/g, '\n');
    const blocks = [];

    // 1. pull out fenced code
    text = text.replace(/```([\w+#.-]*)[ \t]*\n([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, '') });
      return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });
    // 2. pull out tables
    const tables = [];
    text = text.replace(/(?:^|\n)((?:\|.*\|[ \t]*\n){2,})/g, (m, tbl) => {
      tables.push(tbl.trim());
      return `\n\u0000TABLE${tables.length - 1}\u0000\n`;
    });

    const lines = text.split('\n');
    const out = [];
    let i = 0;
    let listStack = [];
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };
    const closeLists = (toDepth) => {
      while (listStack.length > toDepth) out.push(`</${listStack.pop()}>`);
    };

    while (i < lines.length) {
      const line = lines[i];

      if (/^\u0000BLOCK\d+\u0000\s*$/.test(line.trim())) {
        flushPara(); closeLists(0);
        const idx = Number(line.trim().match(/\d+/)[0]);
        out.push(codeBlock(blocks[idx].code, blocks[idx].lang));
        i++; continue;
      }
      if (/^\u0000TABLE\d+\u0000\s*$/.test(line.trim())) {
        flushPara(); closeLists(0);
        const idx = Number(line.trim().match(/\d+/)[0]);
        const rows = tables[idx].split('\n').map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        const body = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
        if (body.length) {
          const head = body.shift();
          out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
            body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
        }
        i++; continue;
      }
      if (!line.trim()) { flushPara(); closeLists(0); i++; continue; }

      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); closeLists(0);
        const lvl = Math.min(4, m[1].length);
        out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i++; continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-*_]/g, '') === '') {
        flushPara(); closeLists(0); out.push('<hr>'); i++; continue;
      }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flushPara(); closeLists(0);
        const quote = [];
        while (i < lines.length && (m = /^\s*>\s?(.*)$/.exec(lines[i]))) { quote.push(m[1]); i++; }
        out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
        continue;
      }
      const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (listMatch) {
        flushPara();
        const indent = listMatch[1].length;
        const ordered = /\d/.test(listMatch[2]);
        const depth = Math.floor(indent / 2) + 1;
        while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
        if (listStack.length === depth) {
          // same list continues
        } else {
          while (listStack.length < depth) {
            const type = ordered ? 'ol' : 'ul';
            out.push(`<${type}>`);
            listStack.push(type);
          }
        }
        out.push(`<li>${inline(listMatch[3])}</li>`);
        i++; continue;
      }
      closeLists(0);
      para.push(line.trim());
      i++;
    }
    flushPara(); closeLists(0);

    let html = out.join('\n');
    // paragraphs that contained only a block placeholder got escaped —
    // placeholders are raw text, so nothing else to unwrap.
    return html
      .replace(/<p><\/p>/g, '')
      .replace(/\u0000BLOCK(\d+)\u0000/g, (_m, n) => codeBlock(blocks[Number(n)].code, blocks[Number(n)].lang));
  }

  window.FlashMD = { render, escapeHtml, highlight };
})();

