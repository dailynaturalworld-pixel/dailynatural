const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { perm, authAny } = require('../services/access');

// Yoga / Exercise ke video aur photo (admin gallery se upload karta hai)
const router = express.Router();
const DIR = require('../config/paths').uploadPath('library');
fs.mkdirSync(DIR, { recursive: true });
const TABLE = { yoga: 'yoga_library', exercise: 'exercise_library' };
const MAX_MB = Number(process.env.MAX_VIDEO_MB) || 200;

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || (file.fieldname === 'video' ? '.mp4' : '.jpg')).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${file.fieldname}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && VIDEO_TYPES.includes(file.mimetype)) return cb(null, true);
    if (file.fieldname === 'image' && IMAGE_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error(file.fieldname === 'video' ? 'BAD_VIDEO' : 'BAD_IMAGE'));
  },
}).fields([{ name: 'video', maxCount: 1 }, { name: 'image', maxCount: 1 }]);

const remove = (name) => name && fs.unlink(path.join(DIR, path.basename(name)), () => {});

function kindOk(req, res) {
  if (!TABLE[req.params.kind]) { res.status(404).json({ message: 'Not found' }); return false; }
  return true;
}

// ---------- UPLOAD ----------
router.post('/:kind/:id', requireAuth, perm('libraries'), (req, res, next) => {
  if (!kindOk(req, res)) return;
  upload(req, res, async (err) => {
    const files = req.files || {};
    const cleanup = () => { remove(files.video?.[0]?.filename); remove(files.image?.[0]?.filename); };
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is too big. Maximum is ${MAX_MB} MB. Try a shorter or compressed video.`
        : err.message === 'BAD_VIDEO' ? 'Video must be MP4, MOV or WEBM.'
        : err.message === 'BAD_IMAGE' ? 'Photo must be JPG, PNG or WEBP.' : 'Upload failed';
      return res.status(400).json({ message: msg });
    }
    try {
      const table = TABLE[req.params.kind];
      const [[row]] = await db.query(`SELECT id, image_file, video_file FROM ${table} WHERE id = ?`, [req.params.id]);
      if (!row) { cleanup(); return res.status(404).json({ message: 'Item not found' }); }
      const v = files.video?.[0]?.filename, i = files.image?.[0]?.filename;
      if (!v && !i) return res.status(400).json({ message: 'Choose a video or a photo' });
      if (v) { remove(row.video_file); await db.query(`UPDATE ${table} SET video_file = ? WHERE id = ?`, [v, row.id]); }
      if (i) { remove(row.image_file); await db.query(`UPDATE ${table} SET image_file = ? WHERE id = ?`, [i, row.id]); }
      await db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)',
        [req.user.id, `${req.params.kind}_media_uploaded`, `${row.id}${v ? ' video' : ''}${i ? ' photo' : ''}`]);
      res.json({ message: v && i ? 'Video and photo uploaded' : v ? 'Video uploaded' : 'Photo uploaded' });
    } catch (e) { cleanup(); next(e); }
  });
});

router.delete('/:kind/:id/:what', requireAuth, perm('libraries'), async (req, res, next) => {
  try {
    if (!kindOk(req, res)) return;
    const col = req.params.what === 'video' ? 'video_file' : req.params.what === 'image' ? 'image_file' : null;
    if (!col) return res.status(400).json({ message: 'Invalid request' });
    const table = TABLE[req.params.kind];
    const [[row]] = await db.query(`SELECT ${col} AS f FROM ${table} WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ message: 'Item not found' });
    remove(row.f);
    await db.query(`UPDATE ${table} SET ${col} = NULL WHERE id = ?`, [req.params.id]);
    res.json({ message: 'Removed' });
  } catch (err) { next(err); }
});

// ---------- DEKHNA (koi bhi logged-in user; video seek ke liye Range support) ----------
router.get('/:kind/:id/:what', authAny, async (req, res, next) => {
  try {
    if (!kindOk(req, res)) return;
    const col = req.params.what === 'video' ? 'video_file' : req.params.what === 'image' ? 'image_file' : null;
    if (!col) return res.status(404).json({ message: 'Not found' });
    const [[row]] = await db.query(`SELECT ${col} AS f FROM ${TABLE[req.params.kind]} WHERE id = ?`, [req.params.id]);
    const file = row?.f && path.join(DIR, path.basename(row.f));
    if (!file || !fs.existsSync(file)) return res.status(404).json({ message: 'Not found' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file); // sendFile khud Range (206) sambhalta hai
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.remove = remove;
