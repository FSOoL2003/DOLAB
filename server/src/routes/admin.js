const express = require("express");
const { pool } = require("../db");
const config = require("../config");
const { requireAdmin } = require("../auth");
const { removeFiles } = require("./uploads");
const { saveCatalog, CatalogError } = require("../catalog");

const router = express.Router();
router.use(requireAdmin);

const TZ = "Asia/Riyadh";
const CONTACT = "('whatsapp', 'copy_phone')";
const rows = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ms = (d) => (d ? d.getTime() : null);

// ---------- الإحصائيات ----------
router.get("/stats", async (req, res) => {
  const [[totals], daily, cities, occasions, top] = await Promise.all([
    rows(`SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS users7d,
      (SELECT count(*) FROM users WHERE banned_at IS NOT NULL)::int AS banned,
      (SELECT count(*) FROM dresses)::int AS dresses,
      (SELECT count(*) FROM dresses WHERE created_at > now() - interval '7 days')::int AS dresses7d,
      (SELECT count(*) FROM dresses WHERE mode IN ('rent', 'both'))::int AS rent,
      (SELECT count(*) FROM dresses WHERE mode IN ('sale', 'both'))::int AS sale,
      (SELECT count(*) FROM dresses WHERE status = 'unavailable')::int AS unavailable,
      (SELECT count(*) FROM dresses WHERE hidden)::int AS hidden,
      (SELECT count(*) FROM dresses WHERE review_status = 'pending')::int AS pending,
      (SELECT count(*) FROM dresses WHERE review_status = 'needs_photos')::int AS needs_photos,
      (SELECT count(DISTINCT visitor) FROM events WHERE type = 'visit' AND created_at > now() - interval '7 days')::int AS visitors7d,
      (SELECT count(DISTINCT visitor) FROM events WHERE type = 'visit')::int AS visitors,
      (SELECT count(*) FROM events WHERE type = 'view')::int AS views,
      (SELECT count(*) FROM events WHERE type = 'view' AND created_at > now() - interval '7 days')::int AS views7d,
      (SELECT count(*) FROM events WHERE type IN ${CONTACT})::int AS contacts,
      (SELECT count(*) FROM events WHERE type IN ${CONTACT} AND created_at > now() - interval '7 days')::int AS contacts7d`),
    rows(`WITH days AS (
        SELECT generate_series((now() AT TIME ZONE $1)::date - 29, (now() AT TIME ZONE $1)::date, interval '1 day')::date AS d
      ),
      ev AS (SELECT (created_at AT TIME ZONE $1)::date AS d, type, visitor FROM events WHERE created_at > now() - interval '31 days')
      SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
        (SELECT count(DISTINCT visitor) FROM ev WHERE ev.d = days.d AND type = 'visit')::int AS visitors,
        (SELECT count(*) FROM ev WHERE ev.d = days.d AND type = 'view')::int AS views,
        (SELECT count(*) FROM ev WHERE ev.d = days.d AND type IN ${CONTACT})::int AS contacts,
        (SELECT count(*) FROM users WHERE (created_at AT TIME ZONE $1)::date = days.d)::int AS signups,
        (SELECT count(*) FROM dresses WHERE (created_at AT TIME ZONE $1)::date = days.d)::int AS listings
      FROM days ORDER BY days.d`, [TZ]),
    rows("SELECT city AS label, count(*)::int AS n FROM dresses GROUP BY city ORDER BY n DESC, city LIMIT 10"),
    rows("SELECT occasion AS label, count(*)::int AS n FROM dresses GROUP BY occasion ORDER BY n DESC, occasion LIMIT 10"),
    rows(`SELECT d.id, d.title, d.photos[1] AS photo, u.name AS owner_name,
        count(e.id) FILTER (WHERE e.type = 'view')::int AS views,
        count(e.id) FILTER (WHERE e.type IN ${CONTACT})::int AS contacts
      FROM dresses d JOIN users u ON u.id = d.owner_id LEFT JOIN events e ON e.dress_id = d.id
      GROUP BY d.id, u.name ORDER BY views DESC, contacts DESC, d.created_at DESC LIMIT 10`),
  ]);
  res.json({ totals, daily, cities, occasions, top });
});

// ---------- المستخدمون ----------
const USER_SELECT = `SELECT u.id, u.email, u.name, u.created_at, u.last_seen_at, u.banned_at,
  (SELECT count(*) FROM dresses d WHERE d.owner_id = u.id)::int AS dresses,
  (SELECT count(*) FROM events e WHERE e.owner_id = u.id AND e.type = 'view')::int AS views_received,
  (SELECT count(*) FROM events e WHERE e.owner_id = u.id AND e.type IN ${CONTACT})::int AS contacts_received,
  (SELECT count(*) FROM events e WHERE e.actor_id = u.id AND e.type = 'view')::int AS views_made,
  (SELECT count(*) FROM events e WHERE e.actor_id = u.id AND e.type IN ${CONTACT})::int AS contacts_made
  FROM users u`;

function userOut(r) {
  return {
    id: String(r.id), email: r.email, name: r.name, isAdmin: config.isAdmin(r.email),
    createdAt: ms(r.created_at), lastSeenAt: ms(r.last_seen_at), bannedAt: ms(r.banned_at),
    dresses: r.dresses, viewsReceived: r.views_received, contactsReceived: r.contacts_received,
    viewsMade: r.views_made, contactsMade: r.contacts_made,
  };
}

router.get("/users", async (req, res) => {
  const list = await rows(`${USER_SELECT} ORDER BY u.created_at DESC`);
  res.json({ users: list.map(userOut) });
});

router.get("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "not_found" });
  const [[u], dresses, activity, received] = await Promise.all([
    rows(`${USER_SELECT} WHERE u.id = $1`, [id]),
    rows(`SELECT d.id, d.title, d.mode, d.status, d.hidden, d.photos[1] AS photo, d.created_at,
        count(e.id) FILTER (WHERE e.type = 'view')::int AS views,
        count(e.id) FILTER (WHERE e.type IN ${CONTACT})::int AS contacts
      FROM dresses d LEFT JOIN events e ON e.dress_id = d.id
      WHERE d.owner_id = $1 GROUP BY d.id ORDER BY d.created_at DESC`, [id]),
    rows(`SELECT e.type, e.dress_id, e.created_at, d.title
      FROM events e LEFT JOIN dresses d ON d.id = e.dress_id
      WHERE e.actor_id = $1 AND e.type <> 'visit' ORDER BY e.created_at DESC LIMIT 60`, [id]),
    rows(`SELECT e.type, e.dress_id, e.created_at, d.title, a.name AS actor_name
      FROM events e LEFT JOIN dresses d ON d.id = e.dress_id LEFT JOIN users a ON a.id = e.actor_id
      WHERE e.owner_id = $1 ORDER BY e.created_at DESC LIMIT 60`, [id]),
  ]);
  if (!u) return res.status(404).json({ error: "not_found" });
  const ev = (r) => ({ type: r.type, dressId: r.dress_id, title: r.title, actorName: r.actor_name || null, at: ms(r.created_at) });
  res.json({
    user: userOut(u),
    dresses: dresses.map((d) => ({ id: d.id, title: d.title, mode: d.mode, status: d.status, hidden: d.hidden, photo: d.photo, createdAt: ms(d.created_at), views: d.views, contacts: d.contacts })),
    activity: activity.map(ev),
    received: received.map(ev),
  });
});

async function targetUser(req, res) {
  const { rows: [u] } = await pool.query("SELECT id, email FROM users WHERE id = $1", [Number(req.params.id) || 0]);
  if (!u) { res.status(404).json({ error: "not_found" }); return null; }
  if (config.isAdmin(u.email)) { res.status(400).json({ error: "admin_protected" }); return null; }
  return u;
}

router.patch("/users/:id", async (req, res) => {
  const banned = (req.body || {}).banned;
  if (typeof banned !== "boolean") return res.status(400).json({ error: "validation" });
  const u = await targetUser(req, res);
  if (!u) return;
  await pool.query("UPDATE users SET banned_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [u.id, banned]);
  if (banned) await pool.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
  res.json({ ok: true });
});

router.delete("/users/:id", async (req, res) => {
  const u = await targetUser(req, res);
  if (!u) return;
  // صور المستخدم + الصور النهائية التي رفعها المشرف لإعلاناته
  const files = await rows("SELECT id FROM uploads WHERE owner_id = $1 OR dress_id IN (SELECT id FROM dresses WHERE owner_id = $1)", [u.id]);
  await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
  await removeFiles(files.map((f) => f.id));
  res.json({ ok: true });
});

// ---------- الإعلانات ----------
router.get("/dresses", async (req, res) => {
  const list = await rows(`SELECT d.*, u.name AS owner_name, u.email AS owner_email, u.banned_at IS NOT NULL AS owner_banned,
      count(e.id) FILTER (WHERE e.type = 'view')::int AS views,
      count(e.id) FILTER (WHERE e.type IN ${CONTACT})::int AS contacts
    FROM dresses d JOIN users u ON u.id = d.owner_id LEFT JOIN events e ON e.dress_id = d.id
    GROUP BY d.id, u.id ORDER BY d.created_at DESC`);
  res.json({
    dresses: list.map((d) => ({
      id: d.id, title: d.title, mode: d.mode, rent: d.rent, sale: d.sale, deposit: d.deposit,
      size: d.size, occasion: d.occasion, condition: d.condition, city: d.city, color: d.color,
      phone: d.phone, photo: d.photos[0] || (d.raw_photos || [])[0] || null, status: d.status, hidden: d.hidden,
      reviewStatus: d.review_status,
      owner: String(d.owner_id), ownerName: d.owner_name, ownerEmail: d.owner_email, ownerBanned: d.owner_banned,
      views: d.views, contacts: d.contacts, createdAt: ms(d.created_at),
    })),
  });
});

router.patch("/dresses/:id", async (req, res) => {
  const hidden = (req.body || {}).hidden;
  if (typeof hidden !== "boolean") return res.status(400).json({ error: "validation" });
  const { rowCount } = await pool.query("UPDATE dresses SET hidden = $1 WHERE id = $2", [hidden, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

// ---------- طلبات النشر ----------
// صاحبة الإعلان ترفع صوراً خاماً؛ المشرف ينزّلها ويجهّزها ثم يرفع النهائية وينشر
router.get("/reviews", async (req, res) => {
  const [list, waiting] = await Promise.all([
    rows(`SELECT d.*, u.name AS owner_name, u.email AS owner_email
      FROM dresses d JOIN users u ON u.id = d.owner_id
      WHERE d.review_status = 'pending' ORDER BY d.submitted_at NULLS LAST, d.created_at`),
    // طلبات أرجعناها لصاحباتها: بانتظار صور جديدة أو تعديل
    rows(`SELECT d.id, d.title, d.review_status, d.review_note, d.submitted_at, u.name AS owner_name, u.email AS owner_email
      FROM dresses d JOIN users u ON u.id = d.owner_id
      WHERE d.review_status IN ('needs_photos', 'rejected') ORDER BY d.submitted_at DESC NULLS LAST LIMIT 100`),
  ]);
  res.json({
    waiting: waiting.map((d) => ({
      id: d.id, title: d.title, status: d.review_status, note: d.review_note,
      ownerName: d.owner_name, ownerEmail: d.owner_email, submittedAt: ms(d.submitted_at),
    })),
    reviews: list.map((d) => ({
      id: d.id, title: d.title, mode: d.mode, rent: d.rent, deposit: d.deposit, sale: d.sale,
      size: d.size, occasion: d.occasion, condition: d.condition, city: d.city, color: d.color, colorHex: d.color_hex,
      desc: d.description, phone: d.phone, rawPhotos: d.raw_photos || [], photos: d.photos || [],
      owner: String(d.owner_id), ownerName: d.owner_name, ownerEmail: d.owner_email,
      // سبق نشره = تعديل على إعلان منشور، لا إعلان جديد
      wasPublished: (d.photos || []).length > 0,
      submittedAt: ms(d.submitted_at || d.created_at), createdAt: ms(d.created_at),
    })),
  });
});

router.post("/dresses/:id/approve", async (req, res) => {
  const photos = (req.body || {}).photos;
  if (!Array.isArray(photos) || !photos.length || photos.length > 4 || !photos.every((p) => typeof p === "string") || new Set(photos).size !== photos.length) {
    return res.status(400).json({ error: "validation" });
  }
  let dropped = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [d] } = await client.query("SELECT photos, raw_photos FROM dresses WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!d) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const raw = d.raw_photos || [], old = d.photos || [];
    // المسموح: الصور الخام أو النهائية الحالية، أو صور جديدة رفعها المشرف ولم تُربط بعد
    const fresh = photos.filter((p) => !raw.includes(p) && !old.includes(p));
    if (fresh.length) {
      const { rows: ok } = await client.query("SELECT id FROM uploads WHERE owner_id = $1 AND dress_id IS NULL AND id = ANY($2)", [req.user.id, fresh]);
      if (ok.length !== fresh.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "bad_photos" }); }
      await client.query("UPDATE uploads SET dress_id = $1 WHERE id = ANY($2)", [req.params.id, fresh]);
    }
    // الصور النهائية القديمة التي لم تعد مستخدمة (وليست خاماً) تُحذف
    dropped = old.filter((p) => !photos.includes(p) && !raw.includes(p));
    if (dropped.length) await client.query("DELETE FROM uploads WHERE id = ANY($1)", [dropped]);
    await client.query(
      "UPDATE dresses SET photos = $2, review_status = 'approved', review_note = NULL, reviewed_at = now() WHERE id = $1",
      [req.params.id, photos]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await removeFiles(dropped);
  res.json({ ok: true });
});

// الصور غير واضحة: نطلب من صاحبة الإعلان صوراً جديدة بدل الرفض
router.post("/dresses/:id/request-photos", async (req, res) => {
  const note = String((req.body || {}).note || "").trim().slice(0, 300);
  if (!note) return res.status(400).json({ error: "validation" });
  const { rowCount } = await pool.query(
    "UPDATE dresses SET review_status = 'needs_photos', review_note = $2 WHERE id = $1 AND review_status = 'pending'",
    [req.params.id, note]
  );
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post("/dresses/:id/reject", async (req, res) => {
  const note = String((req.body || {}).note || "").trim().slice(0, 300);
  if (!note) return res.status(400).json({ error: "validation" });
  const { rowCount } = await pool.query(
    "UPDATE dresses SET review_status = 'rejected', review_note = $2 WHERE id = $1 AND review_status = 'pending'",
    [req.params.id, note]
  );
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

// ---------- الحقول ----------
router.put("/catalog", async (req, res) => {
  try {
    res.json({ catalog: await saveCatalog(req.body || {}) });
  } catch (e) {
    if (e instanceof CatalogError) return res.status(400).json({ error: "validation", field: e.message });
    throw e;
  }
});

module.exports = router;
