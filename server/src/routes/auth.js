const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { startSession, endSession, publicUser, hashPassword, checkPassword } = require("../auth");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function credentials(body) {
  return {
    email: String(body.email || "").trim().toLowerCase(),
    password: String(body.password || ""),
  };
}

router.post("/register", limiter, async (req, res) => {
  const body = req.body || {};
  const { email, password } = credentials(body);
  const name = String(body.name || "").trim();
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: "bad_email" });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "weak_password" });
  if (!name || name.length > 40) return res.status(400).json({ error: "bad_name" });

  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [email, await hashPassword(password), name]
  );
  if (!rows[0]) return res.status(409).json({ error: "email_taken" });
  await startSession(res, rows[0].id);
  res.status(201).json({ user: publicUser(rows[0]) });
});

router.post("/login", limiter, async (req, res) => {
  const { email, password } = credentials(req.body || {});
  const { rows } = await pool.query("SELECT id, email, name, password_hash, banned_at FROM users WHERE email = $1", [email]);
  const ok = await checkPassword(password, rows[0] && rows[0].password_hash);
  if (!rows[0] || !ok) return res.status(401).json({ error: "bad_credentials" });
  if (rows[0].banned_at) return res.status(403).json({ error: "banned" });
  await startSession(res, rows[0].id);
  res.json({ user: publicUser(rows[0]) });
});

router.post("/logout", async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;
