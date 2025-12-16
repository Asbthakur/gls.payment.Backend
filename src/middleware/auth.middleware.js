const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Get user from database
      const result = await query(
        'SELECT id, username, full_name, role, is_active FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User not found' });
      }

      const user = result.rows[0];

      if (!user.is_active) {
        return res.status(401).json({ error: 'User account is deactivated' });
      }

      req.user = user;
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// Role-based authorization
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: `This action requires one of these roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
};

// Check if user can edit/delete (only admin/owner after godown entry)
const canModify = async (req, res, next) => {
  const { role } = req.user;
  
  // Owner can always modify
  if (role === 'owner') {
    return next();
  }

  // For other roles, check if they're the creator
  const { id } = req.params;
  const table = req.baseUrl.includes('inward') ? 'inward_bills' : 
                req.baseUrl.includes('outward') ? 'outward_bills' : null;

  if (!table) {
    return next();
  }

  try {
    const result = await query(
      `SELECT created_by FROM ${table} WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const record = result.rows[0];

    // Only creator or owner can modify
    if (record.created_by !== req.user.id && role !== 'owner') {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Only the creator or owner can modify this record'
      });
    }

    next();
  } catch (error) {
    console.error('Authorization error:', error);
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

module.exports = {
  authenticate,
  authorize,
  canModify,
};
