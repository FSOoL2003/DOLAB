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
// ?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=hour|day|week|month — التواريخ بتوقيت الرياض، و«to» شاملة
const BUCKETS = ["hour", "day", "week", "month"];
const DAY_MS = 86400000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

function parseRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  // اليوم بتوقيت الرياض (UTC+3 بدون توقيت صيفي)
  const today = isoDay(Date.now() + 3 * 3600000);
  let to = re.test(q.to || "") ? q.to : today;
  let from = re.test(q.from || "") ? q.from : isoDay(Date.parse(to) - 29 * DAY_MS);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  if (days > 3 * 366) return null;
  // التجميع التلقائي، مع منع عدد أعمدة غير معقول
  let bucket = BUCKETS.includes(q.bucket) ? q.bucket : days <= 2 ? "hour" : days <= 92 ? "day" : days <= 400 ? "week" : "month";
  const per = { hour: 1 / 24, day: 1, week: 7, month: 30 };
  if (days / per[bucket] > 400) bucket = days / 7 <= 400 ? "week" : "month";
  // الفترة السابقة بنفس الطول مباشرة قبلها، للمقارنة
  const prevTo = isoDay(Date.parse(from) - DAY_MS), prevFrom = isoDay(Date.parse(from) - days * DAY_MS);
  return { from, to, days, bucket, prevFrom, prevTo };
}

// من بداية يوم «from» إلى نهاية يوم «to» بتوقيت الرياض
const SPAN = "($1::date::timestamp AT TIME ZONE '" + TZ + "') AS s, (($2::date + 1)::timestamp AT TIME ZONE '" + TZ + "') AS e";
async function periodTotals(from, to) {
  const [r] = await rows(`WITH w AS (SELECT ${SPAN})
    SELECT
      (SELECT count(DISTINCT visitor) FROM events, w WHERE type = 'visit' AND created_at >= s AND created_at < e)::int AS visitors,
      (SELECT count(*) FROM events, w WHERE type = 'view' AND created_at >= s AND created_at < e)::int AS views,
      (SELECT count(*) FROM events, w WHERE type IN ${CONTACT} AND created_at >= s AND created_at < e)::int AS contacts,
      (SELECT count(*) FROM users, w WHERE created_at >= s AND created_at < e)::int AS signups,
      (SELECT count(*) FROM dresses, w WHERE created_at >= s AND created_at < e)::int AS listings,
      (SELECT count(*) FROM dresses, w WHERE reviewed_at >= s AND reviewed_at < e)::int AS published`, [from, to]);
  return r;
}

router.get("/stats", async (req, res) => {
  const R = parseRange(req.query);
  if (!R) return res.status(400).json({ error: "validation" });
  const B = R.bucket;
  const [[now], current, previous, series, cities, occasions, top] = await Promise.all([
    // الوضع الحالي — لا يتأثر بالفترة
    rows(`SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM users WHERE banned_at IS NOT NULL)::int AS banned,
      (SELECT count(*) FROM dresses)::int AS dresses,
      (SELECT count(*) FROM dresses WHERE review_status = 'approved' AND NOT hidden)::int AS live,
      (SELECT count(*) FROM dresses WHERE mode IN ('rent', 'both'))::int AS rent,
      (SELECT count(*) FROM dresses WHERE mode IN ('sale', 'both'))::int AS sale,
      (SELECT count(*) FROM dresses WHERE status = 'unavailable')::int AS unavailable,
      (SELECT count(*) FROM dresses WHERE hidden)::int AS hidden,
      (SELECT count(*) FROM dresses WHERE review_status = 'pending')::int AS pending,
      (SELECT count(*) FROM dresses WHERE review_status = 'needs_photos')::int AS needs_photos`),
    periodTotals(R.from, R.to),
    periodTotals(R.prevFrom, R.prevTo),
    // عمود لكل ساعة/يوم/أسبوع/شهر في الفترة، حتى الفارغة منها
    rows(`WITH w AS (SELECT ${SPAN}),
      b AS (
        SELECT generate_series(date_trunc('${B}', $1::date::timestamp), date_trunc('${B}', ($2::date + 1)::timestamp - interval '1 second'), interval '1 ${B}') AS t
      ),
      ev AS (
        SELECT date_trunc('${B}', created_at AT TIME ZONE '${TZ}') AS t,
          count(DISTINCT visitor) FILTER (WHERE type = 'visit') AS visitors,
          count(*) FILTER (WHERE type = 'view') AS views,
          count(*) FILTER (WHERE type IN ${CONTACT}) AS contacts
        FROM events, w WHERE created_at >= s AND created_at < e GROUP BY 1
      ),
      us AS (SELECT date_trunc('${B}', created_at AT TIME ZONE '${TZ}') AS t, count(*) AS n FROM users, w WHERE created_at >= s AND created_at < e GROUP BY 1),
      ds AS (SELECT date_trunc('${B}', created_at AT TIME ZONE '${TZ}') AS t, count(*) AS n FROM dresses, w WHERE created_at >= s AND created_at < e GROUP BY 1)
      SELECT to_char(b.t, 'YYYY-MM-DD"T"HH24:MI') AS t,
        coalesce(ev.visitors, 0)::int AS visitors, coalesce(ev.views, 0)::int AS views, coalesce(ev.contacts, 0)::int AS contacts,
        coalesce(us.n, 0)::int AS signups, coalesce(ds.n, 0)::int AS listings
      FROM b LEFT JOIN ev USING (t) LEFT JOIN us USING (t) LEFT JOIN ds USING (t) ORDER BY b.t`, [R.from, R.to]),
    rows("SELECT city AS label, count(*)::int AS n FROM dresses GROUP BY city ORDER BY n DESC, city LIMIT 10"),
    rows("SELECT occasion AS label, count(*)::int AS n FROM dresses GROUP BY occasion ORDER BY n DESC, occasion LIMIT 10"),
    // الأكثر مشاهدة خلال الفترة نفسها
    rows(`WITH w AS (SELECT ${SPAN})
      SELECT d.id, d.title, coalesce(d.photos[1], d.raw_photos[1]) AS photo, u.name AS owner_name,
        count(e.id) FILTER (WHERE e.type = 'view')::int AS views,
        count(e.id) FILTER (WHERE e.type IN ${CONTACT})::int AS contacts
      FROM dresses d JOIN users u ON u.id = d.owner_id
      JOIN events e ON e.dress_id = d.id, w
      WHERE e.created_at >= w.s AND e.created_at < w.e
      GROUP BY d.id, u.name ORDER BY views DESC, contacts DESC LIMIT 10`, [R.from, R.to]),
  ]);
  res.json({ range: R, now, current, previous, series, cities, occasions, top });
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
