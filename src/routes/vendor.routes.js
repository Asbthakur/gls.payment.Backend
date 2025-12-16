const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules, validators, validate } = require('../middleware/validation.middleware');

// All routes require authentication
router.use(authenticate);

// GET /api/vendors - List all vendors with pagination
router.get('/', ...validators.pagination(), asyncHandler(async (req, res) => {
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const sortBy = req.query.sortBy || 'name';
  const sortOrder = req.query.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const activeOnly = req.query.active !== 'false';

  // Build query
  let whereClause = activeOnly ? 'WHERE is_active = true' : '';
  const params = [];
  
  if (search) {
    whereClause += activeOnly ? ' AND' : ' WHERE';
    whereClause += ` (code ILIKE $1 OR name ILIKE $1 OR city ILIKE $1)`;
    params.push(`%${search}%`);
  }

  // Count total
  const countResult = await query(
    `SELECT COUNT(*) FROM vendors ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  // Get vendors
  const vendorsResult = await query(
    `SELECT 
      id, code, name, phone, mobile, whatsapp, email, gstin,
      city, state, default_credit_days, is_active, created_at
    FROM vendors 
    ${whereClause}
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.json({
    data: vendorsResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}));

// GET /api/vendors/dropdown - Simple list for dropdowns
router.get('/dropdown', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, code, name, default_credit_days 
     FROM vendors 
     WHERE is_active = true 
     ORDER BY name`
  );
  res.json(result.rows);
}));

// GET /api/vendors/:id - Get single vendor with outstanding
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Get vendor details
  const vendorResult = await query(
    `SELECT * FROM vendors WHERE id = $1`,
    [id]
  );

  if (vendorResult.rows.length === 0) {
    return res.status(404).json({ error: 'Vendor not found' });
  }

  const vendor = vendorResult.rows[0];

  // Get outstanding summary
  const outstandingResult = await query(
    `SELECT 
      COUNT(id) as total_bills,
      COALESCE(SUM(amount), 0) as total_amount,
      COALESCE(SUM(amount - paid_amount), 0) as outstanding_amount,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN amount - paid_amount ELSE 0 END), 0) as overdue_amount,
      MIN(due_date) as earliest_due_date
    FROM inward_bills 
    WHERE vendor_id = $1 AND status = 'active' AND payment_status != 'paid'`,
    [id]
  );

  // Get recent payments
  const paymentsResult = await query(
    `SELECT 
      pd.id, pd.amount, pd.utr_number, p.payment_date, p.payment_number
    FROM payment_details pd
    JOIN payments p ON pd.payment_id = p.id
    JOIN inward_bills ib ON pd.bill_id = ib.id
    WHERE ib.vendor_id = $1
    ORDER BY p.payment_date DESC
    LIMIT 10`,
    [id]
  );

  res.json({
    vendor,
    summary: outstandingResult.rows[0],
    recentPayments: paymentsResult.rows,
  });
}));

// GET /api/vendors/:id/bills - Get vendor's bills
router.get('/:id/bills', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const status = req.query.status; // 'open', 'partial', 'paid', 'all'
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE vendor_id = $1 AND status = \'active\'';
  const params = [id];

  if (status && status !== 'all') {
    whereClause += ` AND payment_status = $2`;
    params.push(status);
  }

  const billsResult = await query(
    `SELECT 
      id, bill_number, invoice_date, receiving_date, amount, paid_amount,
      (amount - paid_amount) as outstanding, credit_days, due_date,
      payment_status, checked_by, created_at,
      CASE 
        WHEN due_date < CURRENT_DATE THEN CURRENT_DATE - due_date 
        ELSE due_date - CURRENT_DATE 
      END as days_diff,
      CASE WHEN due_date < CURRENT_DATE THEN true ELSE false END as is_overdue
    FROM inward_bills 
    ${whereClause}
    ORDER BY due_date ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) FROM inward_bills ${whereClause}`,
    params
  );

  res.json({
    data: billsResult.rows,
    pagination: {
      page,
      limit,
      total: parseInt(countResult.rows[0].count),
    },
  });
}));

// GET /api/vendors/:id/payments - Get vendor's payment history
router.get('/:id/payments', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const paymentsResult = await query(
    `SELECT 
      p.payment_number, p.payment_date, pd.amount, pd.utr_number,
      ib.bill_number, ba.bank_name,
      u.full_name as proposed_by
    FROM payment_details pd
    JOIN payments p ON pd.payment_id = p.id
    JOIN inward_bills ib ON pd.bill_id = ib.id
    LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
    LEFT JOIN proposals pr ON p.proposal_id = pr.id
    LEFT JOIN users u ON pr.created_by = u.id
    WHERE ib.vendor_id = $1
    ORDER BY p.payment_date DESC, p.created_at DESC
    LIMIT $2 OFFSET $3`,
    [id, limit, offset]
  );

  res.json({
    data: paymentsResult.rows,
    pagination: { page, limit },
  });
}));

// POST /api/vendors - Create vendor
router.post('/', authorize('owner', 'accounts'), validationRules.createVendor, asyncHandler(async (req, res) => {
  const {
    code, name, phone, mobile, whatsapp, email, gstin, pan,
    address, city, state, pincode, bank_name, bank_branch,
    account_number, ifsc_code, account_type, default_credit_days
  } = req.body;

  const result = await query(
    `INSERT INTO vendors (
      code, name, phone, mobile, whatsapp, email, gstin, pan,
      address, city, state, pincode, bank_name, bank_branch,
      account_number, ifsc_code, account_type, default_credit_days, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    RETURNING *`,
    [
      code, name, phone, mobile, whatsapp, email, gstin, pan,
      address, city, state, pincode, bank_name, bank_branch,
      account_number, ifsc_code, account_type || 'current', default_credit_days || 30,
      req.user.id
    ]
  );

  res.status(201).json({
    message: 'Vendor created successfully',
    vendor: result.rows[0],
  });
}));

// PUT /api/vendors/:id - Update vendor
router.put('/:id', authorize('owner', 'accounts'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  // Build dynamic update query
  const allowedFields = [
    'name', 'phone', 'mobile', 'whatsapp', 'email', 'gstin', 'pan',
    'address', 'city', 'state', 'pincode', 'bank_name', 'bank_branch',
    'account_number', 'ifsc_code', 'account_type', 'default_credit_days', 'is_active'
  ];

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(updates[field]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(id);

  const result = await query(
    `UPDATE vendors SET ${setClauses.join(', ')}, updated_at = NOW() 
     WHERE id = $${paramIndex} 
     RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Vendor not found' });
  }

  res.json({
    message: 'Vendor updated successfully',
    vendor: result.rows[0],
  });
}));

// DELETE /api/vendors/:id - Soft delete vendor
router.delete('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Check for outstanding bills
  const outstandingResult = await query(
    `SELECT COUNT(*) FROM inward_bills 
     WHERE vendor_id = $1 AND status = 'active' AND payment_status != 'paid'`,
    [id]
  );

  if (parseInt(outstandingResult.rows[0].count) > 0) {
    return res.status(400).json({ 
      error: 'Cannot delete vendor with outstanding bills',
      outstandingCount: outstandingResult.rows[0].count
    });
  }

  const result = await query(
    `UPDATE vendors SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Vendor not found' });
  }

  res.json({
    message: 'Vendor deactivated successfully',
    vendor: result.rows[0],
  });
}));

module.exports = router;
