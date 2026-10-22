const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");

const router = express.Router();

const TYPES = new Set(["visit", "view", "whatsapp", "copy_phone"]);
// الزيارة وفتح الفستان من نفس الزائر تُحسب مرة كل 30 دقيقة
const DEDUPE = new Set(["visit", "view"]);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

router.post("/", limiter, async (req, res) => {
  const b = req.body || {};
  if (!TYPES.has(b.type)) return res.status(400).json({ error: "validation" });
  const visitor = typeof b.visitor === "string" && /^[a-z0-9]{8,40}$/i.test(b.visitor) ? b.visitor : null;

  let dressId = null, ownerId = null;
  if (b.type !== "visit") {
    const { rows } = await pool.query("SELECT id, owner_id FROM dresses WHERE id = $1", [String(b.dressId || "")]);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    dressId = rows[0].id;
    ownerId = rows[0].owner_id;
    // صاحب الإعلان لا تُحسب نقراته على إعلانه
    if (req.user && String(ownerId) === req.user.id) return res.status(204).end();
  }

  if (DEDUPE.has(b.type) && visitor) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM events WHERE visitor = $1 AND type = $2 AND dress_id IS NOT DISTINCT FROM $3::text
       AND created_at > now() - interval '30 minutes' LIMIT 1`,
      [visitor, b.type, dressId]
    );
    if (rowCount) return res.status(204).end();
  }

  await pool.query(
    "INSERT INTO events (type, dress_id, owner_id, actor_id, visitor) VALUES ($1, $2, $3, $4, $5)",
    [b.type, dressId, ownerId, req.user ? req.user.id : null, visitor]
  );
  res.status(204).end();
});

module.exports = router;
