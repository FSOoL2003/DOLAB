# DOLAB — دولاب الفساتين

منصة لإيجار وبيع فساتين المناسبات (سهرة، زفاف، خطوبة، تخرج…).

- **الموقع:** `public/index.html` — صفحة واحدة: تصفح وفلترة وبحث، إضافة وتعديل الفساتين مع الصور، تواصل واتساب، مشاركة رابط الفستان
- **لوحة التحكم:** `public/admin.html` على `/admin` — إحصائيات، المستخدمون ونقراتهم، الإعلانات، تعديل الحقول
- **السيرفر:** Node.js 20+ و Express 5 في `server/src`
- **قاعدة البيانات:** PostgreSQL — الجداول في `server/src/schema.sql` وتُنشأ/تُحدَّث تلقائياً عند التشغيل
- **الصور:** تُحفظ على القرص في `UPLOAD_DIR` وتُخدم من `/uploads/<id>`

## هيكل المشروع

```
public/            الواجهة (index.html, admin.html, الأيقونات، صورة الخلفية)
server/src/
  index.js         تشغيل السيرفر والمسارات
  schema.sql       الجداول
  auth.js          الجلسات وكلمات المرور
  catalog.js       قوائم الحقول (تُعدَّل من لوحة التحكم وتُحفظ في جدول settings)
  routes/          auth, dresses, uploads, events (تتبّع النقرات), admin
scripts/           سكربتات تجهيز السيرفر والنسخ الاحتياطي
ecosystem.config.js  إعداد pm2
```

## الإعدادات (`.env`)

| المتغير | الوصف |
|---|---|
| `DATABASE_URL` | رابط قاعدة البيانات `postgres://user:pass@host:5432/dolab` |
| `HOST` / `PORT` | عنوان التشغيل، مثل `127.0.0.1` و `3200` |
| `UPLOAD_DIR` | مجلد حفظ الصور |
| `ADMIN_EMAIL` | إيميل المشرف (أكثر من واحد بفاصلة). من يسجّل بهذا الإيميل يصبح مشرفاً |
| `COOKIE_SECURE` | `true` عند التشغيل على HTTPS |

ملف `.env` لا يُرفع على GitHub.

## التشغيل محلياً

```sh
cd server && npm install
# أنشئ .env في جذر المشروع ثم:
node --env-file=../.env src/index.js
```

## النشر الحالي (VPS)

التطبيق يعمل بـ **pm2** خلف **nginx** مع شهادة HTTPS من certbot.

```sh
# أول مرة (بصلاحية root): قاعدة البيانات + موقع nginx + HTTPS
sudo sh scripts/root-setup.sh

# تشغيل التطبيق
cd server && npm install --omit=dev && cd ..
pm2 start ecosystem.config.js && pm2 save

# بعد أي تحديث للكود
pm2 restart dolab
```

ملفات `public/` تُقرأ مباشرة، فتعديلها لا يحتاج إعادة تشغيل.

بديل: `Dockerfile` و `docker-compose.yml` و `Caddyfile` لتشغيل كل شيء بـ Docker على سيرفر فارغ (انظر `.env.example`).

## الـ API

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | الحساب |
| GET | `/api/auth/me` | المستخدم الحالي |
| GET | `/api/catalog` | قوائم الحقول |
| GET | `/api/dresses` | الفساتين الظاهرة |
| POST | `/api/dresses` | إضافة فستان |
| PUT | `/api/dresses/:id` | تعديل فستان (صاحبه) |
| PATCH | `/api/dresses/:id` | متاح / محجوز (صاحبه) |
| DELETE | `/api/dresses/:id` | حذف (صاحبه أو المشرف) |
| POST | `/api/uploads` | رفع صورة (حقل `photo`) |
| POST | `/api/events` | تسجيل نقرة: `visit` · `view` · `whatsapp` · `copy_phone` |
| GET | `/api/admin/stats` · `/users` · `/users/:id` · `/dresses` | لوحة التحكم |
| PATCH/DELETE | `/api/admin/users/:id` | حظر / حذف مستخدم |
| PATCH | `/api/admin/dresses/:id` | إخفاء / إظهار إعلان |
| PUT | `/api/admin/catalog` | حفظ الحقول |

## النسخ الاحتياطي
`scripts/backup.sh` يحفظ قاعدة البيانات والصور (نسخة Docker). على VPS الحالي:
```sh
pg_dump "$DATABASE_URL" | gzip > backups/db-$(date +%F).sql.gz
tar -czf backups/uploads-$(date +%F).tar.gz -C data uploads
```
