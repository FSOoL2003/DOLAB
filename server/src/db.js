const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

async function migrate() {
  // قاعدة البيانات قد تتأخر بالإقلاع عند تشغيل الحاويات معاً
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      console.log("waiting for database…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
}

module.exports = { pool, migrate };
