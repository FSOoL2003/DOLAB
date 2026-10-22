const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");
const config = require("./config");

const COOKIE = "dolab_session";
const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function publicUser(row) {
  return { id: String(row.id), email: row.email, name: row.name, isAdmin: config.isAdmin(row.email) };
}

// يقرأ الجلسة من الكوكي ويضع المستخدم في req.user إن وُجد
async function loadUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (!token) return next();
  const hash = sha256(token);
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.last_seen_at > now() - interval '5 minutes' AS fresh
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.banned_at IS NULL`,
    [hash]
  );
  if (rows[0]) {
    req.user = publicUser(rows[0]);
    req.sessionHash = hash;
    // آخر ظهور: نحدّثه مرة كل 5 دقائق كحد أقصى
    if (!rows[0].fresh) pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  if (!req.user.isAdmin) return res.status(403).json({ error: "forbidden" });
  next();
}

// الكوكي يحمل رمزاً عشوائياً، وقاعدة البيانات تحفظ بصمته فقط
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: "/",
  });
}

async function endSession(req, res) {
  if (req.sessionHash) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [req.sessionHash]);
  res.clearCookie(COOKIE, { path: "/" });
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

// للمستخدم غير الموجود نقارن مع بصمة وهمية حتى لا يكشف زمن الرد وجود الحساب
const DUMMY_HASH = bcrypt.hashSync("dolab-dummy-password", 10);
async function checkPassword(password, hash) {
  return bcrypt.compare(password, hash || DUMMY_HASH);
}

module.exports = { loadUser, requireUser, requireAdmin, startSession, endSession, publicUser, hashPassword, checkPassword };
