const express = require('express');
const db = require('../config/db');
const { authAny, staffCanAccess } = require('../services/access');
const { planPdf, receiptPdf } = require('../services/pdf');
const { hasDietAccess } = require('../services/programs');

const router = express.Router();

// Member: apna plan PDF (?token= se khulta hai, WhatsApp par share kar sakte hain)
router.get('/my-plan', authAny, async (req, res, next) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ message: 'Members only' });
    if (!(await hasDietAccess(req.user.id))) return res.status(403).json({ message: 'Your plan will open after your dietitian gives access.' });
    await planPdf(res, req.user.id);
  } catch (err) { next(err); }
});

// Staff: kisi member ka plan PDF
router.get('/member/:id', authAny, async (req, res, next) => {
  try {
    if (!(await staffCanAccess(req.user, Number(req.params.id)))) return res.status(403).json({ message: 'Not allowed' });
    await planPdf(res, Number(req.params.id), req.query.plan ? Number(req.query.plan) : null);
  } catch (err) { next(err); }
});

router.get('/receipt/:id', authAny, async (req, res, next) => {
  try {
    const [[p]] = await db.query(
      `SELECT pay.*, u.name AS member_name, u.email AS member_email, COALESCE(pk.name, CONCAT(cp.name, ' plan')) AS package_name, pk.duration_days
         FROM payments pay JOIN users u ON u.id = pay.user_id LEFT JOIN packages pk ON pk.id = pay.package_id
         LEFT JOIN condition_programs cp ON cp.code = pay.program_code WHERE pay.id = ?`, [req.params.id]);
    if (!p || p.status !== 'paid') return res.status(404).json({ message: 'Receipt not found' });
    if (req.user.role === 'member' ? p.user_id !== req.user.id : req.user.role !== 'admin') return res.status(404).json({ message: 'Receipt not found' });
    p.valid_text = p.program_code ? 'From the day your dietitian gives access' : p.duration_days ? `${p.duration_days} days` : 'No end date';
    await receiptPdf(res, p);
  } catch (err) { next(err); }
});

module.exports = router;
