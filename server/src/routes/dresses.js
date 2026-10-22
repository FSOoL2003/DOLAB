const crypto = require("crypto");
const express = require("express");
const { pool } = require("../db");
const { requireUser } = require("../auth");
const { removeFiles } = require("./uploads");
const { getCatalog } = require("../catalog");

const MAX_PHOTOS = 4;
const MAX_PER_USER = 50;

const router = express.Router();

const SELECT = "SELECT d.*, u.name AS owner_name FROM dresses d JOIN users u ON u.id = d.owner_id";

function toClient(r) {
  return {
    id: r.id,
    owner: String(r.owner_id),
    ownerName: r.owner_name,
    title: r.title,
    mode: r.mode,
    rent: r.rent,
    deposit: r.deposit,
    sale: r.sale,
    size: r.size,
    occasion: r.occasion,
    condition: r.condition,
    city: r.city,
    color: r.color,
    desc: r.description,
    phone: r.phone,
    photos: r.photos,
    status: r.status,
    createdAt: r.created_at.getTime(),
  };
}

function money(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// keep: قيم الإعلان الحالية عند التعديل — تبقى مقبولة حتى لو حذفها المشرف من القوائم
function validate(b, keep = {}) {
  const C = getCatalog();
  const errors = [];
  const pick = (field, list) => {
    if (!list.includes(b[field]) && !(keep[field] && b[field] === keep[field])) errors.push(field);
    return b[field];
  };
  const mode = pick("mode", ["rent", "sale", "both"]);
  const title = String(b.title || "").trim().slice(0, 80);
  if (!title) errors.push("title");

  const hasRent = mode !== "sale";
  const hasSale = mode !== "rent";
  const rent = hasRent ? money(b.rent, 1, 1e6) : 0;
  const deposit = hasRent ? money(b.deposit || 0, 0, 1e6) : 0;
  const sale = hasSale ? money(b.sale, 1, 1e7) : 0;
  if (rent === null) errors.push("rent");
  if (deposit === null) errors.push("deposit");
  if (sale === null) errors.push("sale");

  const phone = String(b.phone || "").trim();
  if (phone && !/^\+?[\d\s-]{8,18}$/.test(phone)) errors.push("phone");

  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (photos.length > MAX_PHOTOS || !photos.every((p) => typeof p === "string") || new Set(photos).size !== photos.length) {
    errors.push("photos");
  }

  return {
    errors,
    value: {
      title, mode, rent, deposit, sale, phone, photos,
      size: pick("size", C.sizes),
      occasion: pick("occasion", C.occasions),
      condition: pick("condition", C.conditions),
      city: pick("city", C.cities),
      color: pick("color", C.colors.map((c) => c.name)),
      description: String(b.desc || "").trim().slice(0, 600),
    },
  };
}

router.get("/", async (req, res) => {
  // الإعلانات المخفية من المشرف وإعلانات المحظورين لا تظهر للعامة
  const { rows } = await pool.query(`${SELECT} WHERE NOT d.hidden AND u.banned_at IS NULL ORDER BY d.created_at DESC LIMIT 2000`);
  res.json({ dresses: rows.map(toClient) });
});

router.post("/", requireUser, async (req, res) => {
  const { errors, value: v } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: "validation", fields: errors });

  const id = crypto.randomBytes(8).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // قفل على صف المستخدم حتى لا يتجاوز الحد بطلبات متزامنة
    await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM dresses WHERE owner_id = $1", [req.user.id]);
    if (count >= MAX_PER_USER) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "limit_reached" });
    }
    if (v.photos.length) {
      const { rows } = await client.query(
        "SELECT id FROM uploads WHERE owner_id = $1 AND dress_id IS NULL AND id = ANY($2)",
        [req.user.id, v.photos]
      );
      if (rows.length !== v.photos.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "bad_photos" });
      }
    }
    await client.query(
      `INSERT INTO dresses (id, owner_id, title, mode, rent, deposit, sale, size, occasion, condition, city, color, description, phone, photos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, req.user.id, v.title, v.mode, v.rent, v.deposit, v.sale, v.size, v.occasion, v.condition, v.city, v.color, v.description, v.phone, v.photos]
    );
    if (v.photos.length) await client.query("UPDATE uploads SET dress_id = $1 WHERE id = ANY($2)", [id, v.photos]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
  res.status(201).json({ dress: toClient(rows[0]) });
});

// تعديل الإعلان كاملاً — لصاحبه فقط. الصور: القديمة التي بقيت + صور جديدة مرفوعة
router.put("/:id", requireUser, async (req, res) => {
  const { rows: [cur] } = await pool.query("SELECT size, occasion, condition, city, color FROM dresses WHERE id = $1", [req.params.id]);
  const { errors, value: v } = validate(req.body || {}, cur || {});
  if (errors.length) return res.status(400).json({ error: "validation", fields: errors });

  let removed = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [dress] } = await client.query("SELECT owner_id, photos FROM dresses WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!dress || String(dress.owner_id) !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    const added = v.photos.filter((p) => !dress.photos.includes(p));
    if (added.length) {
      const { rows } = await client.query(
        "SELECT id FROM uploads WHERE owner_id = $1 AND dress_id IS NULL AND id = ANY($2)",
        [req.user.id, added]
      );
      if (rows.length !== added.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "bad_photos" });
      }
      await client.query("UPDATE uploads SET dress_id = $1 WHERE id = ANY($2)", [req.params.id, added]);
    }
    removed = dress.photos.filter((p) => !v.photos.includes(p));
    if (removed.length) await client.query("DELETE FROM uploads WHERE id = ANY($1)", [removed]);
    await client.query(
      `UPDATE dresses SET title = $2, mode = $3, rent = $4, deposit = $5, sale = $6, size = $7, occasion = $8,
         condition = $9, city = $10, color = $11, description = $12, phone = $13, photos = $14
       WHERE id = $1`,
      [req.params.id, v.title, v.mode, v.rent, v.deposit, v.sale, v.size, v.occasion, v.condition, v.city, v.color, v.description, v.phone, v.photos]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await removeFiles(removed);

  const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [req.params.id]);
  res.json({ dress: toClient(rows[0]) });
});

// صاحب الإعلان فقط يغيّر حالته (متاح / محجوز أو مُباع)
router.patch("/:id", requireUser, async (req, res) => {
  const status = (req.body || {}).status;
  if (status !== "available" && status !== "unavailable") return res.status(400).json({ error: "validation" });
  const { rowCount } = await pool.query(
    "UPDATE dresses SET status = $1 WHERE id = $2 AND owner_id = $3",
    [status, req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

// صاحب الإعلان أو المشرف يحذفه
router.delete("/:id", requireUser, async (req, res) => {
  const { rows } = await pool.query("SELECT owner_id, photos FROM dresses WHERE id = $1", [req.params.id]);
  const dress = rows[0];
  if (!dress) return res.status(404).json({ error: "not_found" });
  if (String(dress.owner_id) !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "forbidden" });
  await pool.query("DELETE FROM dresses WHERE id = $1", [req.params.id]);
  await removeFiles(dress.photos);
  res.json({ ok: true });
});

module.exports = { router, toClient, SELECT };
