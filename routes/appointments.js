const express = require('express');
const db = require('../config/db');
const { requireAuth, requireFeature } = require('../middleware/auth');
const { notify } = require('../services/notify');
const { isStaff, staffCanAccess, perm, hasPerm } = require('../services/access');
const { toDateStr, isValidDate } = require('../utils');

const router = express.Router();
router.use(requireAuth);

// Booking ke time: subah 9 se shaam 7 tak, har 30 min (lunch 1-2 band)
const SLOTS = [];
for (let h = 9; h < 19; h++) {
  if (h === 13) continue;
  SLOTS.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`);
}
const MODES = ['video', 'phone', 'clinic'];

function prettyTime(t) {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function prettyDay(d) {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Kis staff ke saath booking: assigned dietitian, warna koi admin
async function staffForMember(memberId) {
  const [[m]] = await db.query('SELECT assigned_dietitian_id FROM users WHERE id = ?', [memberId]);
  if (m?.assigned_dietitian_id) return m.assigned_dietitian_id;
  const [[a]] = await db.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");
  return a?.id || null;
}

async function takenSlots(staffId, date, exceptId = 0) {
  const [rows] = await db.query(
    `SELECT appt_time FROM appointments WHERE staff_id <=> ? AND appt_date = ? AND status IN ('requested','confirmed') AND id <> ?`,
    [staffId, date, exceptId]
  );
  return new Set(rows.map((r) => r.appt_time));
}

// ---------- MEMBER ----------
router.get('/slots', requireFeature('appointments'), async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!isValidDate(date) || date < toDateStr()) return res.status(400).json({ message: 'Choose today or a future date' });
    const staffId = await staffForMember(req.user.id);
    const taken = await takenSlots(staffId, date);
    const now = new Date();
    const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    res.json(SLOTS.map((t) => ({ time: t, label: prettyTime(t), available: !taken.has(t) && !(date === toDateStr() && t <= nowHM) })));
  } catch (err) { next(err); }
});

router.get('/', requireFeature('appointments'), async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    const [rows] = await db.query(
      `SELECT a.*, s.name AS staff_name, s.role AS staff_role FROM appointments a LEFT JOIN users s ON s.id = a.staff_id
        WHERE a.member_id = ? ORDER BY a.appt_date DESC, a.appt_time DESC`,
      [req.user.id]
    );
    const today = toDateStr();
    res.json(rows.map((a) => ({
      ...a, time_label: prettyTime(a.appt_time), date_label: prettyDay(String(a.appt_date).slice(0, 10)),
      upcoming: String(a.appt_date).slice(0, 10) >= today && ['requested', 'confirmed'].includes(a.status),
    })));
  } catch (err) { next(err); }
});

router.post('/', requireFeature('appointments'), async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    const { date, time, mode, note } = req.body;
    if (!isValidDate(date) || date < toDateStr()) return res.status(400).json({ message: 'Choose today or a future date' });
    if (!SLOTS.includes(time)) return res.status(400).json({ message: 'Choose a time slot' });
    const [[open]] = await db.query(
      "SELECT COUNT(*) AS c FROM appointments WHERE member_id = ? AND status IN ('requested','confirmed') AND appt_date >= CURDATE()", [req.user.id]);
    if (open.c >= 3) return res.status(400).json({ message: 'You already have 3 upcoming appointments' });
    const staffId = await staffForMember(req.user.id);
    if ((await takenSlots(staffId, date)).has(time)) return res.status(409).json({ message: 'This slot was just booked. Please choose another.' });
    const [r] = await db.query(
      'INSERT INTO appointments (member_id, staff_id, appt_date, appt_time, mode, member_note) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, staffId, date, time, MODES.includes(mode) ? mode : 'video', String(note || '').slice(0, 500) || null]
    );
    res.status(201).json({ id: r.insertId, message: `Requested for ${prettyDay(date)}, ${prettyTime(time)}. You'll be notified when it's confirmed.` });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const [[a]] = await db.query('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ message: 'Not found' });
    const mine = req.user.role === 'member' && a.member_id === req.user.id;
    if (!mine && !(await staffCanAccess(req.user, a.member_id))) return res.status(404).json({ message: 'Not found' });
    if (!mine && !(await hasPerm(req.user, 'appointments'))) return res.status(403).json({ message: 'You do not have permission for this. Ask the admin.' });
    if (!['requested', 'confirmed'].includes(a.status)) return res.status(400).json({ message: 'This appointment cannot be cancelled' });
    await db.query("UPDATE appointments SET status = 'cancelled', staff_note = COALESCE(?, staff_note) WHERE id = ?",
      [isStaff(req.user) ? (req.body.note || null) : null, a.id]);
    if (isStaff(req.user)) {
      await notify(a.member_id, { type: 'appointment', title: 'Appointment cancelled',
        body: `${prettyDay(String(a.appt_date).slice(0, 10))}, ${prettyTime(a.appt_time)}${req.body.note ? ` — ${req.body.note}` : ''}`, link: 'Appointments' });
    }
    res.json({ message: 'Appointment cancelled' });
  } catch (err) { next(err); }
});

// ---------- STAFF ----------
router.get('/staff/all', perm('appointments'), async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const params = [];
    let where = '1 = 1';
    if (req.query.view === 'upcoming') where += " AND a.appt_date >= CURDATE() AND a.status IN ('requested','confirmed')";
    if (req.query.view === 'requested') where += " AND a.status = 'requested'";
    if (req.query.view === 'past') where += " AND (a.appt_date < CURDATE() OR a.status IN ('completed','cancelled'))";
    if (req.user.role !== 'admin') { where += ' AND (a.staff_id = ? OR m.assigned_dietitian_id = ?)'; params.push(req.user.id, req.user.id); }
    if (req.query.member_id) { where += ' AND a.member_id = ?'; params.push(Number(req.query.member_id)); }
    const [rows] = await db.query(
      `SELECT a.*, m.name AS member_name, m.email AS member_email, s.name AS staff_name
         FROM appointments a JOIN users m ON m.id = a.member_id LEFT JOIN users s ON s.id = a.staff_id
        WHERE ${where} ORDER BY a.appt_date ${req.query.view === 'past' ? 'DESC' : 'ASC'}, a.appt_time ASC LIMIT 300`,
      params
    );
    res.json(rows.map((a) => ({ ...a, time_label: prettyTime(a.appt_time), date_label: prettyDay(String(a.appt_date).slice(0, 10)) })));
  } catch (err) { next(err); }
});

router.patch('/staff/:id', perm('appointments'), async (req, res, next) => {
  try {
    const [[a]] = await db.query('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!a || !(await staffCanAccess(req.user, a.member_id))) return res.status(404).json({ message: 'Not found' });
    const { status, meeting_link, staff_note } = req.body;
    if (status && !['confirmed', 'completed'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    await db.query(
      `UPDATE appointments SET status = COALESCE(?, status), meeting_link = COALESCE(?, meeting_link),
         staff_note = COALESCE(?, staff_note), staff_id = COALESCE(staff_id, ?) WHERE id = ?`,
      [status || null, meeting_link ?? null, staff_note ?? null, req.user.id, a.id]
    );
    if (status === 'confirmed') {
      await notify(a.member_id, { type: 'appointment', title: 'Appointment confirmed',
        body: `${prettyDay(String(a.appt_date).slice(0, 10))}, ${prettyTime(a.appt_time)} (${a.mode})${meeting_link ? '. Join link added.' : ''}`,
        link: 'Appointments' });
    }
    res.json({ message: 'Saved' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.SLOTS = SLOTS;
