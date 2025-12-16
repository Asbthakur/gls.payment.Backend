const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { query } = require('../config/database');
const { validate } = require('../middleware/validation.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

// Login validation
const loginValidation = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
];

// POST /api/auth/login
router.post('/login', loginValidation, asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  // Find user
  const result = await query(
    'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = $1',
    [username]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = result.rows[0];

  if (!user.is_active) {
    return res.status(401).json({ error: 'Account is deactivated' });
  }

  // Check password
  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate token
  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  // Generate refresh token
  const refreshToken = jwt.sign(
    { userId: user.id, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  // Update last login
  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  res.json({
    message: 'Login successful',
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    },
    token,
    refreshToken,
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });
}));

// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Get user
    const result = await query(
      'SELECT id, username, full_name, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const user = result.rows[0];

    // Generate new token
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
}));

// GET /api/auth/me - Get current user
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({
    user: req.user,
  });
}));

// POST /api/auth/change-password
router.post('/change-password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
    .matches(/[0-9]/).withMessage('New password must contain a number'),
  validate,
], asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  // Get current password hash
  const result = await query(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  );

  const user = result.rows[0];

  // Verify current password
  const isValid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isValid) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  // Hash new password
  const salt = await bcrypt.genSalt(10);
  const newHash = await bcrypt.hash(newPassword, salt);

  // Update password
  await query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [newHash, userId]
  );

  res.json({ message: 'Password changed successfully' });
}));

// POST /api/auth/logout (optional - for token blacklisting if needed)
router.post('/logout', authenticate, (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // If you need server-side logout, implement token blacklisting here
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
