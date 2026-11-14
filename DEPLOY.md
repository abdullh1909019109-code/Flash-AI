# الاستضافة — FLASH AGENT / Hosting Guide

المنصّة ليست صفحة ثابتة: هي **خادم Node.js + قاعدة بيانات SQLite + مفاتيح API على
السيرفر**. لذلك تحتاج استضافة تشغّل Node وتمنح قرصاً دائماً (Persistent Disk) —
لا يكفي استضافة ملفات ثابتة مثل GitHub Pages.

---

## الخيار ١ — Render (الأسهل، مجاني للتجربة) ✅ الموصى به

1. ارفع المجلد إلى مستودع GitHub (خاص/private أفضل).
2. في [render.com](https://render.com): **New → Blueprint** واختر المستودع.
   الملف `render.yaml` مضبوط مسبقاً، وسيُنشئ الخدمة والقرص تلقائياً.
3. من لوحة Render → **Environment** أضف:
   - `OPENAI_API_KEY` = مفتاحك
   - `ADMIN_INITIAL_PASSWORD` = كلمة مرور الأدمن الأولى (قوية)
   (`APP_SECRET` يُولَّد تلقائياً.)
4. **Deploy**. بعد دقيقة ستجد:
   - التطبيق: `https://flash-agent-xxxx.onrender.com/`
   - لوحة التحكم: `https://flash-agent-xxxx.onrender.com/admin`

> ملاحظة الخطة المجانية: الخدمة تنام بعد 15 دقيقة خمول وتستيقظ في ~30 ثانية.
> القرص الدائم متاح في خطة Starter ($7/شهر) — على المجاني تبقى البيانات داخل
> نسخة الحاوية وقد تُفقد عند إعادة النشر. للإنتاج استخدم Starter.

---

## الخيار ٢ — Fly.io

```bash
fly launch --no-deploy
fly volumes create flash_data --size 1
fly secrets set APP_SECRET=$(openssl rand -base64 48) \
                OPENAI_API_KEY=sk-... \
                ADMIN_INITIAL_PASSWORD='كلمة-مرور-قوية'
fly deploy
```

الملف `fly.toml` جاهز ويستخدم قرصاً دائماً على `/app/data`.

---

## الخيار ٣ — VPS (DigitalOcean / Hetzner / Contabo) — الأرخص للإنتاج

```bash
# Ubuntu 22.04، ودومين يشير إلى IP السيرفر
apt update && apt install -y nodejs npm nginx certbot python3-certbot-nginx git
git clone <repo> /opt/flash-agent && cd /opt/flash-agent
npm install --omit=dev
cp .env.example .env && nano .env     # APP_SECRET + OPENAI_API_KEY + ADMIN_INITIAL_PASSWORD

cp deploy/flash-agent.service /etc/systemd/system/
useradd -r -s /bin/false flash && chown -R flash:flash /opt/flash-agent
systemctl enable --now flash-agent

# Nginx + شهادة SSL مجانية
certbot --nginx -d your-domain.com
```

> مهم: `nginx` يجب أن يعطّل التخزين المؤقت للـ SSE حتى تعمل الكتابة التدريجية:
>
> ```nginx
> location / {
>     proxy_pass http://127.0.0.1:3000;
>     proxy_http_version 1.1;
>     proxy_set_header Host $host;
>     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
>     proxy_set_header X-Forwarded-Proto $scheme;
>     proxy_buffering off;          # ← ضروري للبث المباشر
>     proxy_read_timeout 300s;
>     client_max_body_size 40m;     # ← للصور
> }
> ```

---

## الخيار ٤ — Docker (أي مكان)

```bash
docker compose up -d --build
```

يقوم `docker-compose.yml` بتثبيت مجلد `./data` كـ volume، فتبقى قاعدة البيانات
والصور بعد كل إعادة تشغيل.

---

## بعد النشر — قائمة تحقّق

- [ ] `/api/health` يرجّع `{"ok":true,"database":"connected"}`
- [ ] `/admin` تفتح، وتسجيل الدخول بـ `admin` + كلمة المرور الأولى
- [ ] **تغيير كلمة المرور** يُطلب تلقائياً عند أول دخول (إلزامي)
- [ ] **AI Configuration → Test connection** — يجب أن يظهر
      «Connection verified — authentication and generation both work».
      إذا ظهر `insufficient_credits` فالحساب بلا رصيد في OpenAI.
- [ ] إرسال رسالة في التطبيق وتأكيد وصول رد حقيقي
- [ ] `NODE_ENV=production` مفعّل (يجعل الكوكيز `Secure` ويفعّل HSTS)

## الأمان قبل الفتح للعامة

1. **دوّر مفتاح OpenAI** الذي استُخدم في التطوير (أي مفتاح ظهر في محادثة يجب اعتباره مكشوفاً).
2. كلمة مرور أدمن ≥ 16 حرفاً، وعيّن `APP_SECRET` عشوائياً طويلاً — بدونه لا تُشفَّر مفاتيح المزوّد بشكل سليم.
3. خذ نسخة احتياطية دورية: `data/flash-agent.db` + `data/uploads/`.
4. ضع الخادم خلف HTTPS دائماً (الكوكيز `Secure` تفشل بدون TLS).

## لماذا لا أستطيع استضافته من هنا مباشرة؟

بيئة التنفيذ التي أبني فيها الكود مؤقتة ومعزولة: لا دومين عام، ولا خادم يدوم بعد
انتهاء الجلسة، ولا وصول إلى حساب استضافة باسمك. الملفات جاهزة للنشر بأمر واحد على
أي من الخيارات أعلاه. إن أعطيتني صلاحية نشر (Render/Railway/Fly API token أو SSH
لخادم) أستطيع تنفيذ النشر واختبار الروابط مباشرة.

