-- يُنفَّذ عند كل تشغيل للسيرفر، وكل الأوامر آمنة للتكرار.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS dresses (
  id          TEXT PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('rent', 'sale', 'both')),
  rent        INTEGER NOT NULL DEFAULT 0,
  deposit     INTEGER NOT NULL DEFAULT 0,
  sale        INTEGER NOT NULL DEFAULT 0,
  size        TEXT NOT NULL,
  occasion    TEXT NOT NULL,
  condition   TEXT NOT NULL,
  city        TEXT NOT NULL,
  color       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  photos      TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dresses_created_idx ON dresses(created_at DESC);
CREATE INDEX IF NOT EXISTS dresses_owner_idx ON dresses(owner_id);

-- كل صورة مرفوعة تُسجَّل هنا مع صاحبها، وتُربط بالفستان عند نشره.
-- الصور التي لم تُربط بفستان خلال يوم تُحذف تلقائياً.
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dress_id   TEXT REFERENCES dresses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uploads_orphan_idx ON uploads(created_at) WHERE dress_id IS NULL;

-- لوحة التحكم: الحظر، آخر ظهور، إخفاء الإعلانات
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE dresses ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
-- الدرجة الدقيقة المختارة من خريطة الألوان (color يبقى اسم أقرب لون للبحث)
ALTER TABLE dresses ADD COLUMN IF NOT EXISTS color_hex TEXT;

-- إعدادات قابلة للتعديل من اللوحة (مثل قوائم المقاسات والمدن)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- كل نقرة: زيارة الموقع، فتح فستان، ضغط واتساب، نسخ الرقم
-- owner_id = صاحب الإعلان، actor_id = المستخدم المسجّل الذي نقر (إن وُجد)
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  dress_id   TEXT,
  owner_id   INTEGER,
  actor_id   INTEGER,
  visitor    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at);
CREATE INDEX IF NOT EXISTS events_owner_idx ON events(owner_id, type);
CREATE INDEX IF NOT EXISTS events_actor_idx ON events(actor_id, created_at);
CREATE INDEX IF NOT EXISTS events_dress_idx ON events(dress_id, type);
CREATE INDEX IF NOT EXISTS events_dedupe_idx ON events(visitor, type, created_at);
