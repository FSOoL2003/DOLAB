const fs = require("fs");
const express = require("express");
const config = require("./config");
const { pool, migrate } = require("./db");
const { loadUser } = require("./auth");
const uploads = require("./routes/uploads");
const { loadCatalog, getCatalog } = require("./catalog");

fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  });
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// خريطة الموقع لمحركات البحث — آخر تحديث = آخر فستان أُضيف
app.get("/sitemap.xml", async (req, res) => {
  const { rows } = await pool.query("SELECT max(created_at) AS last FROM dresses WHERE NOT hidden AND review_status = 'approved'");
  const last = (rows[0].last || new Date()).toISOString().slice(0, 10);
  const base = `${req.protocol}://${req.get("host")}`;
  const url = (loc, lang) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${last}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${lang === "ar" ? "1.0" : "0.8"}</priority>
    <xhtml:link rel="alternate" hreflang="ar" href="${base}/"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}/?lang=en"/>
  </url>`;
  res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${url(base + "/", "ar")}
${url(base + "/?lang=en", "en")}
</urlset>
`);
});

// أسماء الصور عشوائية ولا تتغير، لذلك يمكن تخزينها مؤقتاً لمدة طويلة
app.use("/uploads", express.static(config.uploadDir, { maxAge: "365d", immutable: true, index: false }));

app.use(express.json({ limit: "20kb" }));
app.use(loadUser);

// حماية إضافية من الطلبات القادمة من مواقع أخرى
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.get("origin");
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (e) {}
    if (host !== req.get("host")) return res.status(403).json({ error: "bad_origin" });
  }
  next();
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/dresses", require("./routes/dresses").router);
app.use("/api/uploads", uploads.router);
app.use("/api/events", require("./routes/events"));
app.use("/api/admin", require("./routes/admin"));
app.get("/api/catalog", (req, res) => res.json({ catalog: getCatalog() }));
app.use("/api", (req, res) => res.status(404).json({ error: "not_found" }));

// /admin يفتح admin.html
app.use(express.static(config.publicDir, { maxAge: "5m", extensions: ["html"] }));

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE" || err.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "bad_json" });
  if (err.name === "MulterError") return res.status(400).json({ error: "bad_upload" });
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

async function housekeeping() {
  try {
    await pool.query("DELETE FROM sessions WHERE expires_at < now()");
    await uploads.cleanupOrphans();
  } catch (e) {
    console.error("housekeeping failed", e.message);
  }
}

migrate()
  .then(loadCatalog)
  .then(() => {
    app.listen(config.port, config.host, () => console.log(`DOLAB running on ${config.host}:${config.port}`));
    housekeeping();
    setInterval(housekeeping, 6 * 3600 * 1000);
  })
  .catch((e) => {
    console.error("startup failed", e);
    process.exit(1);
  });
