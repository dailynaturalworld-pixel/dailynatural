// Pehla Admin account banane ke liye:
// npm run create-admin -- "Admin Name" admin@example.com yourpassword
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

(async () => {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.log('Usage: npm run create-admin -- "Admin Name" admin@example.com password');
    process.exit(1);
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, 'admin', 1)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', status = 'active'`,
      [name, email.toLowerCase(), hash]
    );
    console.log(`Admin ready: ${email}`);
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
})();
