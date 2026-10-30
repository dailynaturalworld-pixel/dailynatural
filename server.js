require('dotenv').config();

// .env check: JWT_SECRET na ho to server shuru hi na ho (warna login par error aata hai)
if (!process.env.JWT_SECRET) {
  console.error('\n❌ JWT_SECRET is missing. Create backend/.env (copy .env.example to .env) and set JWT_SECRET to a long random line.\n');
  process.exit(1);
}
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
// Razorpay webhook ko raw body chahiye (signature check), isliye json se pehle
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => require('./routes/payments').webhook(req, res));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ app: 'HealthApp API', status: 'running' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/member', require('./routes/member'));
app.use('/api/diet', require('./routes/diet'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/adminExtra'));
app.use('/api/admin', require('./routes/adminPrograms'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/food', require('./routes/food'));
app.use('/api/feed', require('./routes/feed'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/media', require('./routes/media'));

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HealthApp API running on http://localhost:${PORT}`);
});
