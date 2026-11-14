# FLASH AGENT — Your Intelligence. Beyond Limits.

A complete, working AI platform: a public AI application, an independent admin
dashboard, a secure backend API, a persistent database, and an OpenAI-powered
engine with vision, voice, memory and a programming assistant.

> ⚡ **Status of this build:** every route below has been exercised end to end
> (48/48 automated checks, `npm run smoke`). The deployment API key authenticates
> successfully with OpenAI but the account behind it currently returns
> `insufficient_quota` (*"You have no credits remaining"*), so **live answers are
> blocked at the provider**, not by this code. The platform surfaces that as a
> clear error and resumes the moment credits are added — no redeploy needed.

---

## 1. What is inside

| Layer | Location | Notes |
|---|---|---|
| Public AI app | `/` → `public/index.html`, `public/js/app.js` | Chat, Code, Vision, Translate modes; streaming; history; memory; voice |
| Admin dashboard | `/admin` → `public/admin.html`, `public/js/admin.js` | 7 sections, fully wired to the API |
| Backend API | `server/` | Express 4, sessions, rate limits, validation |
| Database | `data/flash-agent.db` | SQLite (WAL), durable across restarts |
| AI engine | `server/engine.js` | OpenAI by default; Gemini / xAI / custom via the dashboard |

### Public application
- New conversation, conversation history grouped by day, pin-aware ordering
- Rename, delete (single or all), search
- Copy reply · Regenerate · Stop generation (aborts the upstream request)
- Markdown + code highlighting with **copy** and **download** per block
- Message timestamps, typing indicator, streaming cursor
- **Flash Code** mode — generate, explain and debug Python/JS/HTML/CSS/PHP/Go/Rust/SQL
- **Flash Vision** — attach up to 4 images, ask anything about them
- **Flash Voice** — speech recognition (Arabic, English, Libyan dialect), text-to-speech,
  8 voices, 0.6×–1.6× speed, auto-read and full voice-conversation mode
- **Flash Memory** — memories injected into the system prompt, editable and deletable by the user
- Arabic / English UI text, RTL-safe layout, mobile-first responsive

### Admin dashboard (`/admin`)
1. **Overview** — users, conversations, messages, requests today, tokens, estimated cost, API status, active model, server health
2. **AI Configuration** — provider type, base URL, API key, model, temperature, max tokens, **Save**, **Test connection**, **Activate**
3. **AI Providers** — multiple providers side by side (OpenAI · Gemini · xAI · custom), add / test / activate / delete without touching code
4. **AI Personality** — AI name, personality, system instructions, default language, Arabic dialect, creativity, response length
5. **User Management** — search, suspend, activate, delete, reset password, create account, promote to admin
6. **Analytics** — daily requests/tokens/cost/errors chart, per-model and per-capability breakdown, error log, top users
7. **General Settings** — app name, slogan, logo, theme, registration on/off, maintenance mode + message, limits, price model, vision/STT/TTS model names

### Security
- bcrypt password hashing (cost 12) — passwords never stored or logged in clear
- Opaque session tokens (32 random bytes), stored **hashed** (SHA-256), HttpOnly + SameSite cookies
- Separate admin session cookie scoped to `/admin`, plus a role check on every admin route
- Provider API keys encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`) and only ever
  returned masked (`sk-pro••••••••s04A`)
- Rate limiting per IP/user, brute-force limiter on both login endpoints, daily message quota
- Input validation and length caps on every body; parameterised SQL everywhere
- Security headers (CSP-adjacent set: nosniff, frame options, referrer policy, HSTS in production)
- Forced password change on the first administrator login
- Suspending a user invalidates all their sessions immediately

---

## 2. Run it

```bash
# 1. dependencies
npm install

# 2. secrets
cp .env.example .env
# edit .env: APP_SECRET (32+ random chars), OPENAI_API_KEY, ADMIN_INITIAL_PASSWORD

# 3. start  (first boot creates the DB + admin account automatically)
npm start
```

Open **http://localhost:3000** for the app and **http://localhost:3000/admin** for the dashboard.

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | – | HTTP port (default 3000) |
| `APP_URL` | – | Public base URL |
| `APP_SECRET` | **yes** | Encrypts provider keys at rest, signs state |
| `OPENAI_API_KEY` | **yes** | Server-side only; never reaches the browser |
| `OPENAI_BASE_URL` | – | Default `https://api.openai.com/v1` |
| `OPENAI_MODEL` | – | Default `gpt-4o-mini` |
| `ADMIN_USERNAME` | – | Default `admin` |
| `ADMIN_INITIAL_PASSWORD` | **yes** | Used once, at first boot, then hashed; the admin must change it on first login |
| `ALLOW_REGISTRATION` | – | `false` closes public sign-up from the start |
| `DATA_DIR` | – | SQLite + uploads directory (default `./data`) |

---

## 3. Verify it

```bash
npm run smoke
```

Boots the real server against a throwaway database and exercises 48 checks:
health, public config, both front-ends, auth + guards, registration, duplicate
rejection, conversations, rename, streaming chat, regenerate, memory CRUD,
suggestions, TTS/STT, vision, admin login, non-admin rejection, forced password
change, overview, provider CRUD, **live connection test**, settings, maintenance
toggle, user suspend/activate/reset/create/delete, analytics, audit log, rate-limit
headers, and admin-lockout.

The live connection test performs two real calls to OpenAI:
`GET /models` (authentication) and `POST /chat/completions` with `max_tokens: 5`
(generation). That second call is exactly how a "no credits" account is caught —
it is reported as `insufficient_credits` with the provider's own message.

---

## 4. API surface

**Public / app**

```
GET    /api/health
GET    /api/public/config
POST   /api/auth/register | /login | /logout | /change-password
GET    /api/auth/me
GET    /api/conversations          POST /api/conversations
GET    /api/conversations/:id      PATCH /api/conversations/:id   DELETE /api/conversations/:id
POST   /api/chat                   (SSE stream: user_message → start → delta* → done | error)
POST   /api/chat/regenerate
DELETE /api/messages/:id
GET    /api/memories   POST /api/memories   DELETE /api/memories/:id | /api/memories
POST   /api/memories/suggest
POST   /api/voice/transcribe       POST /api/voice/speak       GET /api/voice/voices
GET    /api/ai/status
```

**Admin (all behind `requireAdmin`)**

```
POST   /api/admin/login | /logout | /change-password      GET /api/admin/session
GET    /api/admin/overview
GET    /api/admin/providers      POST /api/admin/providers
PATCH  /api/admin/providers/:id  DELETE /api/admin/providers/:id
POST   /api/admin/providers/:id/activate
POST   /api/admin/test-connection
GET    /api/admin/settings       PUT /api/admin/settings
GET    /api/admin/users          POST /api/admin/users
PATCH  /api/admin/users/:id      DELETE /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
GET    /api/admin/analytics?days=14      GET /api/admin/audit
```

### Error contract

Every failure returns `{ error: <code>, message: <human text>, hint: <next step> }`
with a matching HTTP status: `401` bad key/session, `402` insufficient provider
credits, `403` forbidden / password change required, `404` missing model or
resource, `413` input too large, `429` rate limited / daily quota, `502` provider
error, `503` network failure. The UI renders these as an inline banner on the
assistant message — never a fake answer.

---

## 5. Database schema

`users`, `sessions`, `conversations`, `messages`, `memories`, `providers`,
`settings`, `usage_log`, `audit_log` — created on first boot, WAL mode, foreign
keys with cascade delete. Every AI call writes an `usage_log` row with tokens and
an estimated cost (rate configured in Settings). Nothing is seeded with fake
statistics: the dashboard shows what actually happened.

---

## 6. Deploy

```bash
docker compose up -d --build      # needs .env beside docker-compose.yml
```

`docker-compose.yml` mounts `./data` as a named volume so the database and uploads
survive restarts. Behind a proxy, set `NODE_ENV=production` so cookies are marked
`Secure` and HSTS is sent. A `systemd` unit is included in `deploy/flash-agent.service`.

---

## 7. Android (APK)

This repository is **PWA-ready** (manifest + service worker + installable icons):
open the site on Android → Chrome menu → *Add to Home screen* for a full-screen,
app-like install with no build step.

For a real **`.apk`**, use the included Capacitor scaffold:

```bash
bash android/build-apk.sh        # requires JDK 17 + Android SDK
```

It installs Capacitor, generates the native project, points it at your deployed
URL, and produces `android/app-debug.apk` (or a signed release with the
`SIGN_*` variables in `.github/workflows/android.yml`).

A signed APK cannot be compiled inside this build sandbox — it has no JDK or
Android SDK, and Android tooling requires both. Everything needed to produce it
in one command is included.

---

## 8. Project layout

```
flash-agent/
├── server/
│   ├── index.js            HTTP server, middleware, static, errors
│   ├── config.js           env loading, paths, secrets
│   ├── db.js               schema, settings, key encryption, providers
│   ├── auth.js             hashing, sessions, guards
│   ├── rateLimit.js        window limiter + daily quota
│   ├── engine.js           provider-agnostic chat/vision/voice + metering
│   ├── seed.js             first-boot admin + provider
│   ├── routes/             auth, chat, voice, admin
│   └── scripts/smoke-test.js
├── public/
│   ├── index.html  admin.html
│   ├── css/app.css css/admin.css
│   ├── js/app.js  admin.js  markdown.js
│   ├── assets/  sw.js  manifest.webmanifest
├── android/                Capacitor APK scaffold
├── deploy/                 systemd unit
├── Dockerfile  docker-compose.yml
└── .env.example
```

Built to stay modular: a new capability is a new file in `server/routes` plus a
new mode string in `engine.MODES`; a new provider is a row in the dashboard.

---

## ملخّص بالعربية

**فلاش أيجنت** منصّة ذكاء اصطناعي كاملة وجاهزة للتشغيل:

- تطبيق عام على `/` (دردشة، برمجة، رؤية، ترجمة، صوت، ذاكرة) بواجهة عربية وإنجليزية.
- لوحة تحكم مستقلة على `/admin` — اسم المستخدم `admin` وكلمة المرور تُضبط من
  `ADMIN_INITIAL_PASSWORD` في ملف `.env`، وتُخزَّن مشفّرة (bcrypt) مع إلزام
  تغييرها عند أول دخول.
- محرّك OpenAI (الموديل الافتراضي `gpt-4o-mini`) يعمل من جهة الخادم فقط؛ مفتاح
  الـ API لا يصل إلى المتصفح أبداً ويُخزَّن مشفّراً بـ AES-256-GCM.
- قاعدة بيانات SQLite دائمة تحفظ المستخدمين والمحادثات والرسائل والذكريات والإحصاءات.
- زر **Test connection** في اللوحة يجري اتصالاً حقيقياً بـ OpenAI ويُظهر النتيجة بدقّة.

**تنبيه مهم:** مفتاح OpenAI المرفق يعمل ويتم التحقق منه بنجاح، لكن حساب OpenAI
المرتبط به **لا يحتوي على رصيد**، لذلك ترفض المنصّة الردود من المزوّد وتُظهر
رسالة واضحة (`insufficient_credits`). أضف رصيداً في حساب OpenAI أو ضع مفتاحاً
آخر من لوحة التحكم ← AI Configuration، وسيعمل المساعد فوراً دون إعادة نشر.

