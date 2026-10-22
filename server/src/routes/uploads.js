const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { requireUser } = require("../auth");
const config = require("../config");

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 80,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

// نحدد النوع من محتوى الملف نفسه، لا من اسمه أو مما يرسله المتصفح
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

router.post("/", limiter, requireUser, upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const ext = sniff(req.file.buffer);
  if (!ext) return res.status(415).json({ error: "unsupported_type" });
  const id = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  await fs.writeFile(path.join(config.uploadDir, id), req.file.buffer);
  await pool.query("INSERT INTO uploads (id, owner_id) VALUES ($1, $2)", [id, req.user.id]);
  res.status(201).json({ id });
});

async function removeFiles(ids) {
  for (const id of ids || []) {
    try {
      await fs.unlink(path.join(config.uploadDir, path.basename(id)));
    } catch (e) {
      if (e.code !== "ENOENT") console.error("could not remove upload", id, e.message);
    }
  }
}

// صور رُفعت ولم يُنشر فستانها خلال يوم
async function cleanupOrphans() {
  const { rows } = await pool.query(
    "DELETE FROM uploads WHERE dress_id IS NULL AND created_at < now() - interval '1 day' RETURNING id"
  );
  await removeFiles(rows.map((r) => r.id));
}

module.exports = { router, removeFiles, cleanupOrphans };
