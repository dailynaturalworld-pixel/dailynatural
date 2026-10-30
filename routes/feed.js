const express = require('express');
const db = require('../config/db');
const { requireAuth, requireFeature } = require('../middleware/auth');
const { perm, imageUpload, authAny } = require('../services/access');
const { notify, memberIdsForTarget } = require('../services/notify');

const router = express.Router();
const files = imageUpload('feed');
const CATS = ['article', 'tip', 'recipe', 'video'];
const shape = (p) => ({ ...p, has_image: Boolean(p.image_file), image_file: undefined });

// ---------- MEMBER ----------
router.get('/', requireAuth, requireFeature('feed'), async (req, res, next) => {
  try {
    const params = [];
    let where = "status = 'published'";
    if (CATS.includes(req.query.category)) { where += ' AND category = ?'; params.push(req.query.category); }
    const [rows] = await db.query(
      `SELECT id, title, category, summary, image_file, video_url, published_at FROM feed_posts WHERE ${where}
        ORDER BY published_at DESC LIMIT 100`, params);
    res.json(rows.map(shape));
  } catch (err) { next(err); }
});

// ---------- STAFF ----------
router.get('/staff/all', requireAuth, perm('feed'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT f.*, u.name AS author FROM feed_posts f LEFT JOIN users u ON u.id = f.created_by ORDER BY f.updated_at DESC`);
    res.json(rows.map(shape));
  } catch (err) { next(err); }
});

function readBody(b) {
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Write a title' };
  if (!CATS.includes(b.category)) return { error: 'Choose a category' };
  const video = String(b.video_url || '').trim();
  if (video && !/^https?:\/\//.test(video)) return { error: 'Video link must start with http:// or https://' };
  return { title: title.slice(0, 200), category: b.category, summary: String(b.summary || '').slice(0, 300) || null,
    body: String(b.body || '') || null, video_url: video || null, status: b.status === 'published' ? 'published' : 'draft' };
}

router.post('/', requireAuth, perm('feed'), files.single('image'), async (req, res, next) => {
  try {
    const d = readBody(req.body);
    if (d.error) { files.remove(req.file?.filename); return res.status(400).json({ message: d.error }); }
    const [r] = await db.query(
      `INSERT INTO feed_posts (title, category, summary, body, image_file, video_url, status, created_by, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${d.status === 'published' ? 'NOW()' : 'NULL'})`,
      [d.title, d.category, d.summary, d.body, req.file?.filename || null, d.video_url, d.status, req.user.id]);
    if (d.status === 'published' && req.body.notify === '1') {
      notify(await memberIdsForTarget('all'), { type: 'general', title: `New ${d.category}: ${d.title}`, body: d.summary || '', link: 'Feed' }).catch(() => {});
    }
    res.status(201).json({ id: r.insertId, message: d.status === 'published' ? 'Published' : 'Saved as draft' });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, perm('feed'), files.single('image'), async (req, res, next) => {
  try {
    const [[old]] = await db.query('SELECT * FROM feed_posts WHERE id = ?', [req.params.id]);
    if (!old) { files.remove(req.file?.filename); return res.status(404).json({ message: 'Post not found' }); }
    const d = readBody(req.body);
    if (d.error) { files.remove(req.file?.filename); return res.status(400).json({ message: d.error }); }
    let image = old.image_file;
    if (req.file) { files.remove(image); image = req.file.filename; }
    if (req.body.remove_image === '1' && !req.file) { files.remove(image); image = null; }
    await db.query(
      `UPDATE feed_posts SET title = ?, category = ?, summary = ?, body = ?, image_file = ?, video_url = ?, status = ?,
         published_at = ${d.status === 'published' ? 'COALESCE(published_at, NOW())' : 'NULL'} WHERE id = ?`,
      [d.title, d.category, d.summary, d.body, image, d.video_url, d.status, old.id]);
    res.json({ message: 'Saved' });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, perm('feed'), async (req, res, next) => {
  try {
    const [[old]] = await db.query('SELECT image_file FROM feed_posts WHERE id = ?', [req.params.id]);
    if (!old) return res.status(404).json({ message: 'Post not found' });
    await db.query('DELETE FROM feed_posts WHERE id = ?', [req.params.id]);
    files.remove(old.image_file);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ---------- EK POST + PHOTO ----------
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT * FROM feed_posts WHERE id = ?', [req.params.id]);
    if (!p || (p.status !== 'published' && req.user.role === 'member')) return res.status(404).json({ message: 'Post not found' });
    res.json(shape(p));
  } catch (err) { next(err); }
});

router.get('/:id/image', authAny, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT image_file, status FROM feed_posts WHERE id = ?', [req.params.id]);
    if (!p || (p.status !== 'published' && req.user.role === 'member')) return res.status(404).json({ message: 'Not found' });
    files.send(res, p.image_file);
  } catch (err) { next(err); }
});

module.exports = router;
