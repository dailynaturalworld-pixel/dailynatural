const jwt = require('jsonwebtoken');
const db = require('../config/db');

// Login check: token valid hai ya nahi
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Login required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Session expired, please login again' });
  }
}

// Role check: jaise requireRole('admin', 'dietitian')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission for this' });
    }
    next();
  };
}

// Package feature check: member ke package mein feature ON hai ya nahi
function requireFeature(featureCode) {
  return async (req, res, next) => {
    if (req.user.role !== 'member') return next();
    try {
      const [rows] = await db.query(
        `SELECT pf.enabled
           FROM user_packages up
           JOIN package_features pf ON pf.package_id = up.package_id
          WHERE up.user_id = ? AND pf.feature_code = ?
            AND up.status = 'active'
            AND (up.end_date IS NULL OR up.end_date >= CURDATE())
          ORDER BY up.id DESC LIMIT 1`,
        [req.user.id, featureCode]
      );
      if (rows.length && rows[0].enabled) return next();
      return res.status(403).json({
        message: 'This feature is not included in your package',
        feature: featureCode,
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole, requireFeature };
