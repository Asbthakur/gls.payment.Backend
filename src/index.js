require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth.routes');
const vendorRoutes = require('./routes/vendor.routes');
const customerRoutes = require('./routes/customer.routes');
const inwardRoutes = require('./routes/inward.routes');
const outwardRoutes = require('./routes/outward.routes');
const proposalRoutes = require('./routes/proposal.routes');
const paymentRoutes = require('./routes/payment.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const reportRoutes = require('./routes/report.routes');

// Import middleware
const { errorHandler, notFound } = require('./middleware/error.middleware');

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'GLS Payment System',
    version: '1.0.0'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/inward', inwardRoutes);
app.use('/api/outward', outwardRoutes);
app.use('/api/proposals', proposalRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     GLS Payment Management System                 ║
║     Genetec Lifesciences                          ║
╠═══════════════════════════════════════════════════╣
║  🚀 Server running on port ${PORT}                    ║
║  📁 Environment: ${process.env.NODE_ENV || 'development'}                  ║
║  🔗 API: http://localhost:${PORT}/api                 ║
╚═══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
