// قوائم الحقول (المقاسات، المناسبات، ...) محفوظة في جدول settings ويعدّلها المشرف من اللوحة.
// القيم هنا هي البداية فقط عند أول تشغيل.
const { pool } = require("./db");

const DEFAULTS = {
  sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL", "مقاس حر"],
  occasions: ["زفاف", "خطوبة / ملكة", "سهرة", "تخرج", "حناء", "عيد", "أخرى"],
  conditions: ["جديد بالتاغ", "لُبس مرة واحدة", "مستعمل بحالة ممتازة", "مستعمل"],
  cities: ["الرياض", "جدة", "مكة", "المدينة", "الدمام", "الخبر", "الطائف", "أبها", "تبوك", "القصيم", "أخرى"],
  colors: [
    { name: "أبيض", hex: "#F4F1EE" }, { name: "أسود", hex: "#1E1B1E" }, { name: "أحمر", hex: "#B3202E" },
    { name: "عنابي", hex: "#6E1F33" }, { name: "وردي", hex: "#E8A2B8" }, { name: "بنفسجي", hex: "#6B3F8C" },
    { name: "أزرق", hex: "#2F4E8C" }, { name: "أخضر", hex: "#2F6B4F" }, { name: "ذهبي", hex: "#C9A44C" },
    { name: "فضي", hex: "#B8BCC4" }, { name: "بيج", hex: "#D9C3A5" }, { name: "متعدد", hex: "#C98AA0" },
  ],
};
const LISTS = ["sizes", "occasions", "conditions", "cities"];

let current = DEFAULTS;

class CatalogError extends Error {}

function cleanList(list, field) {
  if (!Array.isArray(list)) throw new CatalogError(field);
  const out = [];
  for (const v of list) {
    const s = String(v == null ? "" : v).trim();
    if (!s || s.length > 40) throw new CatalogError(field);
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length || out.length > 80) throw new CatalogError(field);
  return out;
}

function normalize(c) {
  if (!c || typeof c !== "object") throw new CatalogError("catalog");
  const out = {};
  for (const k of LISTS) out[k] = cleanList(c[k], k);
  if (!Array.isArray(c.colors) || !c.colors.length || c.colors.length > 80) throw new CatalogError("colors");
  const seen = new Set();
  out.colors = [];
  for (const col of c.colors) {
    const name = String((col && col.name) || "").trim();
    const hex = String((col && col.hex) || "").trim();
    if (!name || name.length > 40 || !/^#[0-9a-f]{6}$/i.test(hex)) throw new CatalogError("colors");
    if (seen.has(name)) continue;
    seen.add(name);
    out.colors.push({ name, hex: hex.toUpperCase() });
  }
  return out;
}

async function loadCatalog() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'catalog'");
  if (rows[0]) {
    current = normalize(rows[0].value);
  } else {
    await pool.query("INSERT INTO settings (key, value) VALUES ('catalog', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(DEFAULTS)]);
    current = DEFAULTS;
  }
}

async function saveCatalog(c) {
  const value = normalize(c);
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('catalog', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(value)]
  );
  current = value;
  return value;
}

const getCatalog = () => current;

module.exports = { getCatalog, loadCatalog, saveCatalog, CatalogError };
