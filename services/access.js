const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const STAFF = ['admin', 'dietitian', 'coach', 'doctor', 'trainer'];
const isStaff = (u) => u && STAFF.includes(u.role);

// Staff is member ko dekh sakta hai? (admin sab, baaki sirf assigned)
async function staffCanAccess(user, memberId) {
  if (user.role === 'admin') return true;
  if (!isStaff(user)) return false;
  const [[row]] = await db.query(
    "SELECT id FROM users WHERE id = ? AND role = 'member' AND assigned_dietitian_id = ?", [memberId, user.id]);
  return Boolean(row);
}

// Photo upload (chat, diary, progress photos)
function imageUpload(folder) {
  const dir = require('../config/paths').uploadPath(folder);
  fs.mkdirSync(dir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => (/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('ONLY_IMAGES'))),
  });
  // Middleware jo error ko saaf message mein badle
  const single = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too big. Maximum size is 8 MB.'
        : err.message === 'ONLY_IMAGES' ? 'Only photos (JPG, PNG) are allowed.' : 'Upload failed';
      res.status(400).json({ message: msg });
    });
  const send = (res, name) => {
    const file = path.join(dir, path.basename(String(name || '')));
    if (!name || !fs.existsSync(file)) return res.status(404).json({ message: 'File not found' });
    res.sendFile(file);
  };
  const remove = (name) => name && fs.unlink(path.join(dir, path.basename(name)), () => {});
  return { single, send, remove, dir };
}

// Image <img src> ke liye ?token= bhi chalega
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

module.exports = { STAFF, isStaff, staffCanAccess, imageUpload, authAny };

// ================= STAFF PERMISSIONS =================
// Har staff ko kaunse kaam karne ki ijazat hai
const PERMS = {
  plans: 'Create and edit plans & groups',
  libraries: 'Edit yoga, exercise & food library',
  members_edit: "Edit members' health profile",
  chat: 'Chat with members',
  reports: 'Review & reply to reports',
  appointments: 'Manage appointments',
  broadcast: 'Send messages to members',
  feed: 'Publish health feed',
};
const ROLE_DEFAULTS = {
  admin: Object.keys(PERMS),
  dietitian: ['plans', 'libraries', 'members_edit', 'chat', 'reports', 'appointments', 'broadcast', 'feed'],
  coach: ['chat', 'appointments', 'reports', 'libraries'],
  trainer: ['chat', 'appointments', 'libraries'],
  doctor: ['chat', 'reports', 'appointments'],
  member: [],
};

// users row se asli permissions (admin ko hamesha sab)
function effectivePerms(row) {
  if (!row) return [];
  if (row.role === 'admin') return Object.keys(PERMS);
  if (row.permissions) {
    try { return JSON.parse(row.permissions).filter((p) => PERMS[p]); } catch {}
  }
  return ROLE_DEFAULTS[row.role] || [];
}

async function hasPerm(user, code) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!isStaff(user)) return false;
  const [[row]] = await db.query("SELECT role, permissions, status FROM users WHERE id = ?", [user.id]);
  if (!row || row.status !== 'active') return false;
  return effectivePerms(row).includes(code);
}

function perm(code) {
  return async (req, res, next) => {
    try {
      if (await hasPerm(req.user, code)) return next();
      res.status(403).json({ message: 'You do not have permission for this. Ask the admin.' });
    } catch (err) { next(err); }
  };
}

module.exports.PERMS = PERMS;
module.exports.effectivePerms = effectivePerms;
module.exports.hasPerm = hasPerm;
module.exports.perm = perm;
