const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireAuth, requireFeature } = require('../middleware/auth');
const { hasPerm } = require('../services/access');
const { notify } = require('../services/notify');

const router = express.Router();
const STAFF = ['admin', 'dietitian', 'coach', 'doctor', 'trainer'];
const UPLOAD_DIR = require('../config/paths').uploadPath('reports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg')).toLowerCase();
      cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error('ONLY_IMAGES_PDF'));
  },
});

// File dekhne ke liye token header ya ?token= se (image tag ke liye)
function authAny(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ message: 'Login required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Session expired, please login again' });
  }
}

const isStaff = (u) => STAFF.includes(u.role);

// Report dekhne ki permission: member khud, ya staff (dietitian sirf assigned)
async function loadReport(req, id) {
  const [[r]] = await db.query(
    `SELECT r.*, u.name AS member_name, u.email AS member_email, u.assigned_dietitian_id
       FROM member_reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    [id]
  );
  if (!r) return null;
  if (req.user.role === 'member') return r.user_id === req.user.id ? r : null;
  if (req.user.role === 'admin') return r;
  if (isStaff(req.user)) return r.assigned_dietitian_id === req.user.id ? r : null;
  return null;
}

// ---------- MEMBER: apni reports ----------
router.get('/', requireAuth, requireFeature('reports'), async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    const [rows] = await db.query(
      `SELECT r.id, r.title, r.report_type, r.report_date, r.note, r.mime_type, r.status, r.created_at,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = r.id) AS reply_count,
              EXISTS(SELECT 1 FROM report_replies rr WHERE rr.report_id = r.id AND rr.sender_role <> 'member'
                       AND rr.created_at > COALESCE(r.member_seen_at, '2000-01-01')) AS has_new_reply
         FROM member_reports r WHERE r.user_id = ? ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, has_new_reply: Boolean(r.has_new_reply) })));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireFeature('reports'), (req, res, next) => {
  if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too big. Maximum size is 10 MB.'
        : err.message === 'ONLY_IMAGES_PDF' ? 'Only photos (JPG, PNG) and PDF files are allowed.' : 'Upload failed';
      return res.status(400).json({ message: msg });
    }
    try {
      if (!req.file) return res.status(400).json({ message: 'Please choose a photo or PDF' });
      const { title, report_type, report_date, note } = req.body;
      if (!title || !String(title).trim()) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: 'Please give the report a name' });
      }
      const [r] = await db.query(
        `INSERT INTO member_reports (user_id, title, report_type, report_date, note, file_name, original_name, mime_type, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, String(title).trim(), report_type || null,
         /^\d{4}-\d{2}-\d{2}$/.test(report_date || '') ? report_date : null,
         note || null, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size]
      );
      res.status(201).json({ id: r.insertId, message: 'Report uploaded. Your dietitian will review it.' });
    } catch (e) {
      next(e);
    }
  });
});

// ---------- STAFF: saari reports ----------
router.get('/admin/all', requireAuth, async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const params = [];
    let where = '1 = 1';
    if (['pending', 'reviewed'].includes(req.query.status)) { where += ' AND r.status = ?'; params.push(req.query.status); }
    if (req.query.member_id) { where += ' AND r.user_id = ?'; params.push(Number(req.query.member_id)); }
    if (req.query.search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR r.title LIKE ?)';
      const s = `%${req.query.search}%`; params.push(s, s, s);
    }
    if (req.user.role !== 'admin') { where += ' AND u.assigned_dietitian_id = ?'; params.push(req.user.id); }
    const [rows] = await db.query(
      `SELECT r.id, r.user_id, r.title, r.report_type, r.report_date, r.mime_type, r.status, r.created_at,
              u.name AS member_name, u.email AS member_email,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = r.id) AS reply_count
         FROM member_reports r JOIN users u ON u.id = r.user_id
        WHERE ${where} ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- EK REPORT + REPLIES ----------
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await loadReport(req, req.params.id);
    if (!r) return res.status(404).json({ message: 'Report not found' });
    const [replies] = await db.query(
      `SELECT rr.id, rr.message, rr.sender_role, rr.created_at, u.name AS sender_name
         FROM report_replies rr LEFT JOIN users u ON u.id = rr.sender_id
        WHERE rr.report_id = ? ORDER BY rr.created_at ASC, rr.id ASC`,
      [r.id]
    );
    if (req.user.role === 'member') await db.query('UPDATE member_reports SET member_seen_at = NOW() WHERE id = ?', [r.id]);
    delete r.assigned_dietitian_id;
    res.json({ ...r, replies });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/file', authAny, async (req, res, next) => {
  try {
    const r = await loadReport(req, req.params.id);
    if (!r) return res.status(404).json({ message: 'Report not found' });
    const file = path.join(UPLOAD_DIR, path.basename(r.file_name));
    if (!fs.existsSync(file)) return res.status(404).json({ message: 'File missing on server' });
    res.setHeader('Content-Type', r.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.original_name || r.file_name)}"`);
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/replies', requireAuth, async (req, res, next) => {
  try {
    const r = await loadReport(req, req.params.id);
    if (!r) return res.status(404).json({ message: 'Report not found' });
    if (isStaff(req.user) && !(await hasPerm(req.user, 'reports'))) return res.status(403).json({ message: 'You do not have permission for this. Ask the admin.' });
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Please write a message' });
    if (message.length > 3000) return res.status(400).json({ message: 'Message is too long' });
    await db.query('INSERT INTO report_replies (report_id, sender_id, sender_role, message) VALUES (?, ?, ?, ?)',
      [r.id, req.user.id, req.user.role, message]);
    if (isStaff(req.user)) {
      await db.query("UPDATE member_reports SET status = 'reviewed' WHERE id = ?", [r.id]);
      await notify(r.user_id, { type: 'report', title: `Reply on "${r.title}"`, body: message.slice(0, 120), link: 'Reports' });
    }
    res.status(201).json({ message: 'Reply sent' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const r = await loadReport(req, req.params.id);
    if (!r) return res.status(404).json({ message: 'Report not found' });
    if (!['pending', 'reviewed'].includes(req.body.status)) return res.status(400).json({ message: 'Invalid status' });
    await db.query('UPDATE member_reports SET status = ? WHERE id = ?', [req.body.status, r.id]);
    res.json({ message: 'Updated' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await loadReport(req, req.params.id);
    if (!r || (req.user.role === 'member' && r.user_id !== req.user.id)) return res.status(404).json({ message: 'Report not found' });
    if (!['member', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Not allowed' });
    await db.query('DELETE FROM member_reports WHERE id = ?', [r.id]);
    fs.unlink(path.join(UPLOAD_DIR, path.basename(r.file_name)), () => {});
    res.json({ message: 'Report deleted' });
  } catch (err) {
    next(err);
  }
});

// Account delete hone par files bhi hatao
async function deleteUserReportFiles(userId) {
  const [rows] = await db.query('SELECT file_name FROM member_reports WHERE user_id = ?', [userId]);
  rows.forEach((r) => fs.unlink(path.join(UPLOAD_DIR, path.basename(r.file_name)), () => {}));
  await db.query('DELETE FROM member_reports WHERE user_id = ?', [userId]);
}

module.exports = router;
module.exports.deleteUserReportFiles = deleteUserReportFiles;
