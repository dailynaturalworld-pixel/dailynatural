// Uploads (photos, reports, chat files, PDF, videos) kahan save hon
// Hostinger jaise hosting par har deploy mein app folder naya banta hai, isliye
// .env mein UPLOAD_DIR ko app folder se BAHAR ka folder dijiye, jaise /home/u123456789/healthapp-uploads
const path = require('path');

const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

const uploadPath = (...parts) => path.join(UPLOAD_ROOT, ...parts);

module.exports = { UPLOAD_ROOT, uploadPath };
