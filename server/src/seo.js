// صفحات قابلة للفهرسة: صفحة لكل فستان منشور، وصفحات للمناسبات والمدن.
// نأخذ public/index.html نفسه ونحقن فيه العنوان والوصف والبيانات المنظمة ومحتوى مكتوب في HTML،
// حتى يقرأه Google مباشرة. الواجهة تعمل كما هي فوقه.
const fs = require("fs/promises");
const path = require("path");
const { pool } = require("./db");
const config = require("./config");

// [slug, عربي, English] — القيم الأساسية فقط؛ ما يضيفه المشرف لاحقاً بدون slug لا يأخذ صفحة
const OCC = {
  "زفاف": ["wedding", "فساتين زفاف", "Wedding dresses"],
  "خطوبة / ملكة": ["engagement", "فساتين خطوبة وملكة", "Engagement dresses"],
  "سهرة": ["evening", "فساتين سهرة", "Evening dresses"],
  "تخرج": ["graduation", "فساتين تخرج", "Graduation dresses"],
  "حناء": ["henna", "فساتين حناء", "Henna dresses"],
  "عيد": ["eid", "فساتين عيد", "Eid dresses"],
};
const CITY = {
  "الرياض": ["riyadh", "Riyadh"], "جدة": ["jeddah", "Jeddah"], "مكة": ["makkah", "Makkah"], "المدينة": ["madinah", "Madinah"],
  "الدمام": ["dammam", "Dammam"], "الخبر": ["khobar", "Khobar"], "الطائف": ["taif", "Taif"], "أبها": ["abha", "Abha"],
  "تبوك": ["tabuk", "Tabuk"], "القصيم": ["qassim", "Qassim"],
};
const occBySlug = Object.fromEntries(Object.entries(OCC).map(([k, v]) => [v[0], k]));
const cityBySlug = Object.fromEntries(Object.entries(CITY).map(([k, v]) => [v[0], k]));

const LIVE = "d.review_status = 'approved' AND NOT d.hidden AND u.banned_at IS NULL";
const FROM = "FROM dresses d JOIN users u ON u.id = d.owner_id";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const nf = new Intl.NumberFormat("en-US");

// يجب أن يطابق slugify في public/index.html
function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKC").replace(/[ً-ْـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "dress";
}
const dressPath = (d) => "/dress/" + d.id + "-" + encodeURIComponent(slugify(d.title));
function listingPath(occ, city) {
  if (occ && city) return "/dresses/" + OCC[occ][0] + "/" + CITY[city][0];
  if (occ) return "/dresses/" + OCC[occ][0];
  return "/dresses/in/" + CITY[city][0];
}

// إحصائيات صغيرة نستخدمها في روابط التصنيفات وفي الخريطة — نخزنها دقيقة واحدة
let statsCache = { at: 0, rows: [] };
// يُستدعى عند النشر أو الحذف أو الإخفاء حتى تظهر التصنيفات الجديدة فوراً
function invalidate() { statsCache.at = 0; }
async function stats() {
  if (Date.now() - statsCache.at < 60000) return statsCache.rows;
  const { rows } = await pool.query(
    `SELECT d.occasion, d.city, count(*)::int AS n, min(NULLIF(d.rent, 0))::int AS min_rent, min(NULLIF(d.sale, 0))::int AS min_sale
     ${FROM} WHERE ${LIVE} GROUP BY 1, 2`
  );
  statsCache = { at: Date.now(), rows };
  return rows;
}
function summarize(rows, occ, city) {
  let n = 0, minRent = null, minSale = null;
  for (const r of rows) {
    if ((occ && r.occasion !== occ) || (city && r.city !== city)) continue;
    n += r.n;
    if (r.min_rent != null && (minRent == null || r.min_rent < minRent)) minRent = r.min_rent;
    if (r.min_sale != null && (minSale == null || r.min_sale < minSale)) minSale = r.min_sale;
  }
  return { n, minRent, minSale };
}

// روابط التصنيفات أسفل الصفحة: فقط ما فيه فساتين، حتى لا ندلّ Google على صفحات فارغة
async function categoryLinks(en) {
  const rows = await stats();
  const occs = Object.keys(OCC).map((o) => [o, summarize(rows, o, null).n]).filter(([, n]) => n);
  const cities = Object.keys(CITY).map((c) => [c, summarize(rows, null, c).n]).filter(([, n]) => n);
  const combos = rows.filter((r) => OCC[r.occasion] && CITY[r.city]).sort((a, b) => b.n - a.n).slice(0, 10);
  if (!occs.length && !cities.length) return "";
  const q = en ? "?lang=en" : "";
  const li = (href, text, n) => `<li><a href="${href}${q}">${esc(text)} <span>${nf.format(n)}</span></a></li>`;
  const col = (title, items) => items.length ? `<div><h2>${esc(title)}</h2><ul>${items.join("")}</ul></div>` : "";
  return `<nav class="seo-links" aria-label="${en ? "Browse dresses" : "تصفّحي الفساتين"}">
  ${col(en ? "By occasion" : "حسب المناسبة", occs.map(([o, n]) => li(listingPath(o, null), OCC[o][en ? 2 : 1], n)))}
  ${col(en ? "By city" : "حسب المدينة", cities.map(([c, n]) => li(listingPath(null, c), (en ? "Dresses in " + CITY[c][1] : "فساتين في " + c), n)))}
  ${col(en ? "Popular" : "الأكثر طلباً", combos.map((r) => li(listingPath(r.occasion, r.city), en ? OCC[r.occasion][2] + " in " + CITY[r.city][1] : OCC[r.occasion][1] + " في " + r.city, r.n)))}
</nav>`;
}

// يحقن بيانات الصفحة في index.html
async function render(req, res, p) {
  let html = await fs.readFile(path.join(config.publicDir, "index.html"), "utf8");
  const base = `${req.protocol}://${req.get("host")}`;
  const en = req.query.lang === "en";
  const url = base + p.path + (en ? "?lang=en" : "");
  const rep = (re, fn) => { html = html.replace(re, fn); };

  if (p.title) {
    rep(/<title>[^<]*<\/title>/, () => `<title>${esc(p.title)}</title>`);
    rep(/<meta property="og:title" content="[^"]*">/, () => `<meta property="og:title" content="${esc(p.title)}">`);
    rep(/<meta name="twitter:title" content="[^"]*">/, () => `<meta name="twitter:title" content="${esc(p.title)}">`);
  }
  if (p.description) {
    rep(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(p.description)}">`);
    rep(/<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${esc(p.description)}">`);
    rep(/<meta name="twitter:description" content="[^"]*">/, () => `<meta name="twitter:description" content="${esc(p.description)}">`);
  }
  if (p.image) {
    rep(/<meta property="og:image" content="[^"]*">\s*<meta property="og:image:width"[^>]*>\s*<meta property="og:image:height"[^>]*>/, () => `<meta property="og:image" content="${esc(p.image)}">`);
    rep(/<meta name="twitter:image" content="[^"]*">/, () => `<meta name="twitter:image" content="${esc(p.image)}">`);
  }
  if (p.ogType) rep(/<meta property="og:type" content="[^"]*">/, () => `<meta property="og:type" content="${p.ogType}">`);
  rep(/<meta property="og:url" content="[^"]*">/, () => `<meta property="og:url" content="${esc(url)}">`);
  rep(
    /<link rel="alternate" hreflang="ar"[^>]*>\s*<link rel="alternate" hreflang="en"[^>]*>\s*<link rel="alternate" hreflang="x-default"[^>]*>/,
    () => `<link rel="canonical" href="${esc(url)}">
<link rel="alternate" hreflang="ar" href="${esc(base + p.path)}">
<link rel="alternate" hreflang="en" href="${esc(base + p.path + "?lang=en")}">
<link rel="alternate" hreflang="x-default" href="${esc(base + p.path)}">` + (p.noindex ? '\n<meta name="robots" content="noindex, follow">' : "")
  );
  const head = (p.jsonld || []).map((o) => `<script type="application/ld+json">${json(o)}</script>`).join("\n")
    + `\n<script>window.__SSR = ${json(p.ssr || { type: "home" })};</script>`;
  rep(/<\/head>/, () => head + "\n</head>");
  // في الصفحات الداخلية يصير عنوان الصفحة هو الـ h1، وعنوان الواجهة الكبير يبقى شكلاً فقط
  if (p.top) {
    rep(/<h1 style="--i:1">([\s\S]*?)<\/h1>/, (m, inner) => `<div class="hero-h1" style="--i:1">${inner}</div>`);
    rep(/<main class="wrap">/, () => `<main class="wrap">\n${p.top}`);
  }
  const links = await categoryLinks(en);
  if (links) rep(/<\/main>/, () => `${links}\n</main>`);

  res.status(p.status || 200).set("Cache-Control", "public, max-age=60").type("html").send(html);
}

function crumbsHtml(items, en) {
  const q = en ? "?lang=en" : "";
  return `<nav class="crumbs" aria-label="${en ? "Breadcrumb" : "مسار الصفحة"}">` +
    items.map(([text, href], i) => (href && i < items.length - 1 ? `<a href="${href}${q}">${esc(text)}</a>` : `<span>${esc(text)}</span>`)).join(" <i>›</i> ") + "</nav>";
}
function crumbsLd(base, items, en) {
  return {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: items.map(([name, href], i) => ({ "@type": "ListItem", position: i + 1, name, item: base + (href || "") + (en ? "?lang=en" : "") })),
  };
}

async function home(req, res) {
  await render(req, res, { path: "/", ssr: { type: "home" } });
}

async function listing(req, res, occ, city) {
  const en = req.query.lang === "en";
  const base = `${req.protocol}://${req.get("host")}`;
  const { n, minRent, minSale } = summarize(await stats(), occ, city);
  const pathname = listingPath(occ, city);
  const occAr = occ ? OCC[occ][1] : "فساتين المناسبات", occEn = occ ? OCC[occ][2] : "Occasion dresses";
  const cityAr = city ? " في " + city : " في السعودية", cityEn = city ? " in " + CITY[city][1] : " in Saudi Arabia";

  const h1 = en ? `${occEn} for rent & sale${cityEn}` : `${occAr} للإيجار والبيع${cityAr}`;
  const title = (en ? `Rent & buy ${occEn.toLowerCase()}${cityEn}` : `إيجار وبيع ${occAr}${cityAr}`) + (en ? " | DOLAB" : " | دولاب");
  const priceAr = minRent ? `، بأسعار إيجار تبدأ من ${nf.format(minRent)} ر.س لليلة` : minSale ? `، بأسعار تبدأ من ${nf.format(minSale)} ر.س` : "";
  const priceEn = minRent ? `, with rentals from SAR ${nf.format(minRent)} a night` : minSale ? `, from SAR ${nf.format(minSale)}` : "";
  // العدد بصيغة صحيحة: فستان واحد / 3 فساتين / 15 فستاناً
  const countAr = n === 1 ? "فستان واحد" : n === 2 ? "فستانين" : n <= 10 ? `${nf.format(n)} فساتين` : `${nf.format(n)} فستاناً`;
  const countEn = n === 1 ? "1 dress" : `${nf.format(n)} dresses`;
  const intro = n
    ? (en
      ? `Browse ${occEn.toLowerCase()}${cityEn} to rent or buy on DOLAB — ${countEn} listed now${priceEn}. Every listing is reviewed and photographed consistently by the DOLAB team, and you message the owner directly on WhatsApp.`
      : `تصفّحي ${occAr}${cityAr} للإيجار أو الشراء على دولاب، معروض حالياً ${countAr}${priceAr}. كل الإعلانات مراجَعة وصورها مجهّزة من فريق دولاب، وتتواصلي مع صاحبة الفستان مباشرة على واتساب.`)
    : (en
      ? `There are no ${occEn.toLowerCase()}${cityEn} listed right now — new dresses are added every day. Browse all dresses or list your own.`
      : `ما في ${occAr}${cityAr} معروضة حالياً، والفساتين الجديدة بتنضاف كل يوم. تصفّحي كل الفساتين أو اعرضي فستانك.`);

  const items = [[en ? "DOLAB" : "دولاب", "/"]];
  if (occ && city) items.push([en ? occEn : occAr, listingPath(occ, null)]);
  items.push([en ? h1 : (occ ? occAr : "فساتين") + cityAr, pathname]);

  await render(req, res, {
    path: pathname, title, description: intro.slice(0, 300), noindex: !n,
    ssr: { type: "listing", occ: occ || "", city: city || "" },
    jsonld: [crumbsLd(base, items, en), { "@context": "https://schema.org", "@type": "CollectionPage", name: h1, description: intro, url: base + pathname }],
    top: `<section class="landing">${crumbsHtml(items, en)}<h1>${esc(h1)}</h1><p>${esc(intro)}</p></section>`,
  });
}

async function dress(req, res) {
  const en = req.query.lang === "en";
  const base = `${req.protocol}://${req.get("host")}`;
  const m = /^([0-9a-f]{16})(?:-(.*))?$/.exec(req.params.key || "");
  const id = m && m[1];
  const { rows: [d] } = id
    ? await pool.query(`SELECT d.*, u.name AS owner_name ${FROM} WHERE d.id = $1 AND ${LIVE}`, [id])
    : { rows: [] };

  // غير منشور أو غير موجود: الواجهة تقرر (صاحبة الإعلان ترى إعلانها قيد المراجعة)، وGoogle لا يفهرس
  if (!d) {
    return render(req, res, {
      path: req.path, status: 404, noindex: true,
      title: en ? "Dress not available | DOLAB" : "الفستان غير متاح | دولاب",
      ssr: { type: "dress", id: id || "" },
    });
  }
  // الرابط الصحيح دائماً بالعنوان الحالي للفستان
  const canonical = dressPath(d);
  if (req.path !== canonical && decodeURIComponent(req.path) !== decodeURIComponent(canonical)) {
    return res.redirect(301, canonical + (en ? "?lang=en" : ""));
  }

  const photos = (d.photos || []).map((p) => base + "/uploads/" + encodeURIComponent(p));
  const hasRent = d.mode !== "sale" && d.rent, hasSale = d.mode !== "rent" && d.sale;
  const priceAr = [hasRent ? `إيجار ${nf.format(d.rent)} ر.س لليلة` : "", hasSale ? `بيع ${nf.format(d.sale)} ر.س` : ""].filter(Boolean).join(" · ");
  const priceEn = [hasRent ? `Rent SAR ${nf.format(d.rent)} / night` : "", hasSale ? `Buy SAR ${nf.format(d.sale)}` : ""].filter(Boolean).join(" · ");
  const modeAr = d.mode === "both" ? "للإيجار والبيع" : d.mode === "sale" ? "للبيع" : "للإيجار";
  const modeEn = d.mode === "both" ? "for rent & sale" : d.mode === "sale" ? "for sale" : "for rent";
  const title = en ? `${d.title} — ${modeEn} in ${CITY[d.city] ? CITY[d.city][1] : d.city} | DOLAB` : `${d.title} ${modeAr} في ${d.city} | دولاب`;
  const description = (en
    ? `${d.title}: ${priceEn}. Size ${d.size}, ${d.color}, ${d.condition}, in ${d.city}. ${d.description || ""}`
    : `${d.title}: ${priceAr}. مقاس ${d.size}، ${d.color}، ${d.condition}، في ${d.city}. ${d.description || ""}`).trim().slice(0, 300);

  const available = d.status === "available" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
  const offers = [];
  if (hasRent) offers.push({
    "@type": "Offer", url: base + canonical, price: d.rent, priceCurrency: "SAR", availability: available,
    businessFunction: "http://purl.org/goodrelations/v1#LeaseOut",
    priceSpecification: { "@type": "UnitPriceSpecification", price: d.rent, priceCurrency: "SAR", referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "DAY" } },
  });
  if (hasSale) offers.push({
    "@type": "Offer", url: base + canonical, price: d.sale, priceCurrency: "SAR", availability: available,
    itemCondition: d.condition === "جديد بالتاغ" ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition",
  });

  const items = [[en ? "DOLAB" : "دولاب", "/"]];
  if (OCC[d.occasion]) items.push([OCC[d.occasion][en ? 2 : 1], listingPath(d.occasion, null)]);
  if (OCC[d.occasion] && CITY[d.city]) items.push([en ? "In " + CITY[d.city][1] : "في " + d.city, listingPath(d.occasion, d.city)]);
  items.push([d.title, canonical]);

  const specs = [["المقاس", "Size", d.size], ["المناسبة", "Occasion", d.occasion], ["اللون", "Color", d.color], ["الحالة", "Condition", d.condition], ["المدينة", "City", d.city]]
    .filter(([, , v]) => v).map(([ar, enL, v]) => `<li><span>${en ? enL : ar}</span> ${esc(v)}</li>`).join("");
  const top = `<article class="ssr-dress" id="ssrDress">${crumbsHtml(items, en)}
  <div class="ssr-grid">
    ${photos[0] ? `<img src="${esc(photos[0])}" alt="${esc(d.title)}" loading="eager">` : ""}
    <div>
      <h1>${esc(d.title)}</h1>
      <p class="ssr-price">${esc(en ? priceEn : priceAr)}</p>
      <ul class="ssr-specs">${specs}</ul>
      ${d.description ? `<p>${esc(d.description)}</p>` : ""}
    </div>
  </div>
</article>`;

  await render(req, res, {
    path: canonical, title, description, image: photos[0], ogType: "product",
    ssr: { type: "dress", id: d.id },
    jsonld: [
      crumbsLd(base, items, en),
      {
        "@context": "https://schema.org", "@type": "Product", name: d.title, description: d.description || description,
        image: photos, category: d.occasion, color: d.color, size: d.size, sku: d.id,
        brand: { "@type": "Brand", name: "DOLAB" }, offers,
      },
    ],
    top,
  });
}

// خريطة الموقع: الرئيسية، كل فستان منشور مع صوره، وصفحات التصنيفات التي فيها فساتين
async function sitemap(req, res) {
  const base = `${req.protocol}://${req.get("host")}`;
  const [{ rows: dresses }, rows] = await Promise.all([
    pool.query(`SELECT d.id, d.title, d.photos, coalesce(d.reviewed_at, d.created_at) AS updated ${FROM} WHERE ${LIVE} ORDER BY d.created_at DESC LIMIT 5000`),
    stats(),
  ]);
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const last = dresses[0] ? day(dresses[0].updated) : day(Date.now());
  const alt = (p) => `<xhtml:link rel="alternate" hreflang="ar" href="${esc(base + p)}"/><xhtml:link rel="alternate" hreflang="en" href="${esc(base + p + "?lang=en")}"/>`;
  const url = (p, lastmod, prio, extra = "") => `  <url><loc>${esc(base + p)}</loc><lastmod>${lastmod}</lastmod><priority>${prio}</priority>${alt(p)}${extra}</url>`;
  const out = [url("/", last, "1.0")];
  for (const d of dresses) {
    const imgs = (d.photos || []).map((ph) => `<image:image><image:loc>${esc(base + "/uploads/" + encodeURIComponent(ph))}</image:loc><image:title>${esc(d.title)}</image:title></image:image>`).join("");
    out.push(url(dressPath(d), day(d.updated), "0.8", imgs));
  }
  const pages = new Set();
  for (const o of Object.keys(OCC)) if (summarize(rows, o, null).n) pages.add(listingPath(o, null));
  for (const c of Object.keys(CITY)) if (summarize(rows, null, c).n) pages.add(listingPath(null, c));
  for (const r of rows) if (OCC[r.occasion] && CITY[r.city]) pages.add(listingPath(r.occasion, r.city));
  for (const p of pages) out.push(url(p, last, "0.7"));
  res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${out.join("\n")}
</urlset>
`);
}

function mount(app) {
  app.get("/", home);
  app.get("/sitemap.xml", sitemap);
  app.get("/dress/:key", dress);
  app.get("/dresses/in/:city", (req, res, next) => { const c = cityBySlug[req.params.city]; return c ? listing(req, res, null, c) : next(); });
  app.get("/dresses/:occ", (req, res, next) => { const o = occBySlug[req.params.occ]; return o ? listing(req, res, o, null) : next(); });
  app.get("/dresses/:occ/:city", (req, res, next) => {
    const o = occBySlug[req.params.occ], c = cityBySlug[req.params.city];
    return o && c ? listing(req, res, o, c) : next();
  });
}

module.exports = { mount, slugify, invalidate };
