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

// صاحبة الإعلان وحدها ترى صورها الخام وملاحظة المراجعة
function toClient(r, viewerId) {
  const own = viewerId != null && String(r.owner_id) === String(viewerId);
  const out = {
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
    colorHex: r.color_hex,
    desc: r.description,
    phone: r.phone,
    photos: r.photos,
    status: r.status,
    reviewStatus: r.review_status,
    createdAt: r.created_at.getTime(),
  };
  if (own) {
    out.rawPhotos = r.raw_photos || r.photos;
    out.reviewNote = r.review_note;
  }
  return out;
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
  // رقم التواصل إجباري: بدونه ما في طريقة للزبونة توصل لصاحبة الفستان
  if (!/^\+?[\d\s-]{8,18}$/.test(phone)) errors.push("phone");

  const colorHex = b.colorHex == null || b.colorHex === "" ? null : String(b.colorHex);
  if (colorHex && !/^#[0-9a-f]{6}$/i.test(colorHex)) errors.push("colorHex");

  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (photos.length > MAX_PHOTOS || !photos.every((p) => typeof p === "string") || new Set(photos).size !== photos.length) {
    errors.push("photos");
  }

  return {
    errors,
    value: {
      title, mode, rent, deposit, sale, phone, photos,
      colorHex: colorHex && colorHex.toUpperCase(),
      size: pick("size", C.sizes),
      occasion: pick("occasion", C.occasions),
      condition: pick("condition", C.conditions),
      city: pick("city", C.cities),
      color: pick("color", C.colors.map((c) => c.name)),
      description: String(b.desc || "").trim().slice(0, 600),
    },
  };
}

// يتأكد أن الصور الجديدة مرفوعة من هذا المستخدم وغير مربوطة بإعلان آخر
async function ownFreshUploads(client, userId, ids) {
  if (!ids.length) return true;
  const { rows } = await client.query(
    "SELECT id FROM uploads WHERE owner_id = $1 AND dress_id IS NULL AND id = ANY($2)",
    [userId, ids]
  );
  return rows.length === ids.length;
}

router.get("/", async (req, res) => {
  // للعامة: المنشور فقط. وصاحبة الإعلان ترى إعلاناتها كلها (قيد المراجعة والمرفوضة أيضاً)
  const me = req.user ? Number(req.user.id) : null;
  const { rows } = await pool.query(
    `${SELECT} WHERE (d.review_status = 'approved' AND NOT d.hidden AND u.banned_at IS NULL) OR d.owner_id = $1
     ORDER BY d.created_at DESC LIMIT 2000`,
    [me]
  );
  res.json({ dresses: rows.map((r) => toClient(r, me)) });
});

router.post("/", requireUser, async (req, res) => {
  const { errors, value: v } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: "validation", fields: errors });
  if (!v.photos.length) return res.status(400).json({ error: "photos_required" });

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
    if (!(await ownFreshUploads(client, req.user.id, v.photos))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "bad_photos" });
    }
    // الإعلان الجديد ينتظر أن يجهّز المشرف صوره
    await client.query(
      `INSERT INTO dresses (id, owner_id, title, mode, rent, deposit, sale, size, occasion, condition, city, color, color_hex,
         description, phone, photos, raw_photos, review_status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '{}', $16, 'pending', now())`,
      [id, req.user.id, v.title, v.mode, v.rent, v.deposit, v.sale, v.size, v.occasion, v.condition, v.city, v.color, v.colorHex, v.description, v.phone, v.photos]
    );
    await client.query("UPDATE uploads SET dress_id = $1 WHERE id = ANY($2)", [id, v.photos]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
  res.status(201).json({ dress: toClient(rows[0], req.user.id) });
});

// تعديل الإعلان — لصاحبته فقط. الصور هنا هي الخام: تغييرها يعيد الإعلان للمراجعة.
// تعديل النص أو السعر لإعلان منشور يظهر مباشرة. والمرفوض يعود للمراجعة بأي تعديل.
router.put("/:id", requireUser, async (req, res) => {
  const { rows: [cur] } = await pool.query("SELECT size, occasion, condition, city, color FROM dresses WHERE id = $1", [req.params.id]);
  const { errors, value: v } = validate(req.body || {}, cur || {});
  if (errors.length) return res.status(400).json({ error: "validation", fields: errors });
  if (!v.photos.length) return res.status(400).json({ error: "photos_required" });

  let removed = [], resubmitted = false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [dress] } = await client.query(
      "SELECT owner_id, photos, raw_photos, review_status FROM dresses WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!dress || String(dress.owner_id) !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    const raw = dress.raw_photos || dress.photos;
    const added = v.photos.filter((p) => !raw.includes(p));
    if (!(await ownFreshUploads(client, req.user.id, added))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "bad_photos" });
    }
    if (added.length) await client.query("UPDATE uploads SET dress_id = $1 WHERE id = ANY($2)", [req.params.id, added]);

    const photosChanged = added.length > 0 || raw.some((p) => !v.photos.includes(p));
    // المشرف طلب صوراً أوضح: لازم ترفع صورة جديدة واحدة على الأقل قبل الإرسال
    if (dress.review_status === "needs_photos" && !added.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "new_photos_required" });
    }
    const reopen = dress.review_status === "rejected" || dress.review_status === "needs_photos";
    const status = photosChanged || reopen ? "pending" : dress.review_status;
    resubmitted = status === "pending" && dress.review_status !== "pending";

    // نحذف الخام المحذوف، إلا إذا كان المشرف استخدمه كصورة نهائية
    removed = raw.filter((p) => !v.photos.includes(p) && !dress.photos.includes(p));
    if (removed.length) await client.query("DELETE FROM uploads WHERE id = ANY($1)", [removed]);

    await client.query(
      `UPDATE dresses SET title = $2, mode = $3, rent = $4, deposit = $5, sale = $6, size = $7, occasion = $8,
         condition = $9, city = $10, color = $11, description = $12, phone = $13, raw_photos = $14, color_hex = $15,
         review_status = $16,
         review_note = CASE WHEN $16 = 'pending' THEN NULL ELSE review_note END,
         submitted_at = CASE WHEN $17 THEN now() ELSE submitted_at END
       WHERE id = $1`,
      [req.params.id, v.title, v.mode, v.rent, v.deposit, v.sale, v.size, v.occasion, v.condition, v.city, v.color,
        v.description, v.phone, v.photos, v.colorHex, status, resubmitted]
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
  res.json({ dress: toClient(rows[0], req.user.id), resubmitted });
});

// صاحبة الإعلان فقط تغيّر حالته (متاح / محجوز أو مُباع)
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

// صاحبة الإعلان أو المشرف يحذفه
router.delete("/:id", requireUser, async (req, res) => {
  const { rows } = await pool.query("SELECT owner_id, photos, raw_photos FROM dresses WHERE id = $1", [req.params.id]);
  const dress = rows[0];
  if (!dress) return res.status(404).json({ error: "not_found" });
  if (String(dress.owner_id) !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "forbidden" });
  await pool.query("DELETE FROM dresses WHERE id = $1", [req.params.id]);
  await removeFiles([...new Set([...(dress.photos || []), ...(dress.raw_photos || [])])]);
  res.json({ ok: true });
});

module.exports = { router, toClient, SELECT };
