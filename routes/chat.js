const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../services/notify');
const { isStaff, staffCanAccess, imageUpload, authAny, perm } = require('../services/access');
const { requireFeature } = require('../middleware/auth');

const router = express.Router();
const files = imageUpload('chat');

const MSG_SQL = `SELECT c.id, c.message, c.sender_role, c.created_at, c.image_file IS NOT NULL AND c.image_file NOT LIKE '%.pdf' AS has_image, c.image_file LIKE '%.pdf' AS is_pdf,
                        u.name AS sender_name
                   FROM chat_messages c LEFT JOIN users u ON u.id = c.sender_id
                  WHERE c.member_id = ? ORDER BY c.id DESC LIMIT 200`;

async function saveMessage(req, memberId) {
  const message = String(req.body.message || '').trim().slice(0, 3000);
  if (!message && !req.file) return null;
  const staff = isStaff(req.user);
  const [r] = await db.query(
    `INSERT INTO chat_messages (member_id, sender_id, sender_role, message, image_file, read_by_member, read_by_staff)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [memberId, req.user.id, req.user.role, message || null, req.file?.filename || null, staff ? 0 : 1, staff ? 1 : 0]
  );
  return { id: r.insertId, message };
}

// ---------- MEMBER ----------
router.get('/', requireAuth, requireFeature('chat'), async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    const [rows] = await db.query(MSG_SQL, [req.user.id]);
    await db.query('UPDATE chat_messages SET read_by_member = 1 WHERE member_id = ? AND read_by_member = 0', [req.user.id]);
    const [[coach]] = await db.query(
      `SELECT d.name, d.role FROM users m LEFT JOIN users d ON d.id = m.assigned_dietitian_id WHERE m.id = ?`, [req.user.id]);
    res.json({ coach: coach?.name ? coach : { name: 'Your health team', role: 'dietitian' }, messages: rows.reverse() });
  } catch (err) { next(err); }
});

router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const [[r]] = await db.query(
      'SELECT COUNT(*) AS c FROM chat_messages WHERE member_id = ? AND read_by_member = 0', [req.user.id]);
    res.json({ count: r.c });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requireFeature('chat'), files.single('image'), async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    const saved = await saveMessage(req, req.user.id);
    if (!saved) return res.status(400).json({ message: 'Write a message or add a photo' });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

// ---------- STAFF ----------
router.get('/staff/conversations', requireAuth, perm('chat'), async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const scope = req.user.role === 'admin' ? '' : 'AND u.assigned_dietitian_id = ' + Number(req.user.id);
    const [rows] = await db.query(
      `SELECT u.id AS member_id, u.name, u.email,
              (SELECT message FROM chat_messages WHERE member_id = u.id ORDER BY id DESC LIMIT 1) AS last_message,
              (SELECT image_file IS NOT NULL FROM chat_messages WHERE member_id = u.id ORDER BY id DESC LIMIT 1) AS last_is_image,
              (SELECT created_at FROM chat_messages WHERE member_id = u.id ORDER BY id DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*) FROM chat_messages WHERE member_id = u.id AND read_by_staff = 0) AS unread
         FROM users u
        WHERE u.role = 'member' AND u.status <> 'deleted' ${scope}
          AND EXISTS (SELECT 1 FROM chat_messages WHERE member_id = u.id)
        ORDER BY last_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/staff/:memberId', requireAuth, perm('chat'), async (req, res, next) => {
  try {
    const memberId = Number(req.params.memberId);
    if (!(await staffCanAccess(req.user, memberId))) return res.status(403).json({ message: 'Not allowed' });
    const [[member]] = await db.query("SELECT id, name, email FROM users WHERE id = ? AND role = 'member'", [memberId]);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const [rows] = await db.query(MSG_SQL, [memberId]);
    await db.query('UPDATE chat_messages SET read_by_staff = 1 WHERE member_id = ? AND read_by_staff = 0', [memberId]);
    res.json({ member, messages: rows.reverse() });
  } catch (err) { next(err); }
});

router.post('/staff/:memberId', requireAuth, perm('chat'), files.single('image'), async (req, res, next) => {
  try {
    const memberId = Number(req.params.memberId);
    if (!(await staffCanAccess(req.user, memberId))) return res.status(403).json({ message: 'Not allowed' });
    const saved = await saveMessage(req, memberId);
    if (!saved) return res.status(400).json({ message: 'Write a message or add a photo' });
    await notify(memberId, {
      type: 'chat',
      title: `New message from ${req.user.name || 'your dietitian'}`,
      body: saved.message ? saved.message.slice(0, 120) : 'Sent you a photo',
      link: 'Chat',
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

// ---------- PHOTO ----------
router.get('/image/:id', authAny, async (req, res, next) => {
  try {
    const [[m]] = await db.query('SELECT member_id, image_file FROM chat_messages WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ message: 'Not found' });
    const ok = req.user.role === 'member' ? m.member_id === req.user.id : await staffCanAccess(req.user, m.member_id);
    if (!ok) return res.status(404).json({ message: 'Not found' });
    files.send(res, m.image_file);
  } catch (err) { next(err); }
});

module.exports = router;
