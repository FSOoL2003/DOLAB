const path = require("path");

const adminEmails = (process.env.ADMIN_EMAIL || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, "..", "..", "public"),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),
  // يُفعَّل بعد ربط الدومين وتشغيل HTTPS
  cookieSecure: process.env.COOKIE_SECURE === "true",
  // المشرف يستطيع حذف أي إعلان
  isAdmin: (email) => adminEmails.includes(String(email || "").toLowerCase()),
};
