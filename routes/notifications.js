const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify, memberIdsForTarget } = require('../services/notify');
const { STAFF, perm } = require('../services/access');

const router = express.Router();
router.use(requireAuth);

// ---------- MEMBER ----------
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const [[r]] = await db.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ count: r.c });
  } catch (err) { next(err); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await db.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ message: 'Done' });
  } catch (err) { next(err); }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    await db.query('UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Done' });
  } catch (err) { next(err); }
});

// Phone ka Expo push token save
router.post('/push-token', async (req, res, next) => {
  try {
    const token = String(req.body.token || '');
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) return res.status(400).json({ message: 'Invalid token' });
    await db.query(
      'INSERT INTO push_tokens (token, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      [token, req.user.id]
    );
    res.json({ message: 'Saved' });
  } catch (err) { next(err); }
});

// ---------- ADMIN: bulk message ----------
router.post('/broadcast', perm('broadcast'), async (req, res, next) => {
  try {
    const { target_type, target_id } = req.body;
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!title) return res.status(400).json({ message: 'Write a title' });
    if (!['all', 'group', 'member'].includes(target_type)) return res.status(400).json({ message: 'Choose who gets this message' });
    if (target_type !== 'all' && !target_id) return res.status(400).json({ message: 'Choose a group or member' });
    if (req.user.role !== 'admin' && target_type === 'all') return res.status(403).json({ message: 'Only admin can message everyone' });
    const ids = await memberIdsForTarget(target_type, target_id);
    const count = await notify(ids, { type: 'broadcast', title, body, link: 'Notifications' });
    await db.query(
      'INSERT INTO broadcasts (sent_by, target_type, target_id, title, body, recipients) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, target_type, target_type === 'all' ? null : target_id, title, body, count]
    );
    res.json({ message: `Sent to ${count} member${count === 1 ? '' : 's'}`, recipients: count });
  } catch (err) { next(err); }
});

router.get('/broadcasts', requireRole(...STAFF), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, u.name AS sent_by_name,
              CASE b.target_type WHEN 'group' THEN (SELECT name FROM member_groups WHERE id = b.target_id)
                                 WHEN 'member' THEN (SELECT name FROM users WHERE id = b.target_id)
                                 ELSE 'All members' END AS target_name
         FROM broadcasts b LEFT JOIN users u ON u.id = b.sent_by ORDER BY b.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
