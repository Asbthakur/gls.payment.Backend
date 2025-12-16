const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authenticate, authorize, canModify } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules, validators } = require('../middleware/validation.middleware');

router.use(authenticate);

// GET /api/inward - List inward bills with filters
router.get('/', ...validators.pagination(), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const vendorId = req.query.vendor_id;
  const status = req.query.status; // open, partial, paid
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;
  const overdue = req.query.overdue === 'true';
  const dueToday = req.query.due_today === 'true';

  let whereClause = "WHERE ib.status = 'active'";
  const params = [];
  let paramIndex = 1;

  if (search) {
    whereClause += ` AND (v.code ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex} OR ib.bill_number ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  if (vendorId) {
    whereClause += ` AND ib.vendor_id = $${paramIndex}`;
    params.push(vendorId);
    paramIndex++;
  }

  if (status) {
    whereClause += ` AND ib.payment_status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (dateFrom) {
    whereClause += ` AND ib.receiving_date >= $${paramIndex}`;
    params.push(dateFrom);
    paramIndex++;
  }

  if (dateTo) {
    whereClause += ` AND ib.receiving_date <= $${paramIndex}`;
    params.push(dateTo);
    paramIndex++;
  }

  if (overdue) {
    whereClause += ` AND ib.due_date < CURRENT_DATE AND ib.payment_status != 'paid'`;
  }

  if (dueToday) {
    whereClause += ` AND ib.due_date = CURRENT_DATE AND ib.payment_status != 'paid'`;
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM inward_bills ib 
     JOIN vendors v ON ib.vendor_id = v.id ${whereClause}`,
    params
  );

  const billsResult = await query(
    `SELECT 
      ib.id, ib.bill_number, ib.invoice_date, ib.receiving_date,
      ib.amount, ib.paid_amount, (ib.amount - ib.paid_amount) as outstanding,
      ib.credit_days, ib.due_date, ib.payment_status, ib.checked_by,
      ib.remarks, ib.created_at,
      v.id as vendor_id, v.code as vendor_code, v.name as vendor_name,
      u.full_name as created_by_name,
      CASE 
        WHEN ib.due_date < CURRENT_DATE THEN CURRENT_DATE - ib.due_date 
        ELSE ib.due_date - CURRENT_DATE 
      END as days_diff,
      CASE WHEN ib.due_date < CURRENT_DATE THEN true ELSE false END as is_overdue
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    ${whereClause}
    ORDER BY ib.receiving_date DESC, ib.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  res.json({
    data: billsResult.rows,
    pagination: {
      page,
      limit,
      total: parseInt(countResult.rows[0].count),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    },
  });
}));

// GET /api/inward/today - Today's entries
router.get('/today', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT 
      ib.*, v.code as vendor_code, v.name as vendor_name,
      u.full_name as created_by_name
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    WHERE ib.receiving_date = CURRENT_DATE AND ib.status = 'active'
    ORDER BY ib.created_at DESC`
  );

  const summary = await query(
    `SELECT 
      COUNT(*) as count,
      COALESCE(SUM(amount), 0) as total_amount
    FROM inward_bills 
    WHERE receiving_date = CURRENT_DATE AND status = 'active'`
  );

  res.json({
    data: result.rows,
    summary: summary.rows[0],
  });
}));

// GET /api/inward/by-date/:date - Entries by specific date
router.get('/by-date/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;

  const result = await query(
    `SELECT 
      ib.*, v.code as vendor_code, v.name as vendor_name,
      u.full_name as created_by_name
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    WHERE ib.receiving_date = $1 AND ib.status = 'active'
    ORDER BY ib.created_at DESC`,
    [date]
  );

  const summary = await query(
    `SELECT 
      COUNT(*) as count,
      COALESCE(SUM(amount), 0) as total_amount
    FROM inward_bills 
    WHERE receiving_date = $1 AND status = 'active'`,
    [date]
  );

  res.json({
    date,
    data: result.rows,
    summary: summary.rows[0],
  });
}));

// GET /api/inward/summary - Summary stats
router.get('/summary', asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date = CURRENT_DATE AND status = 'active') as today_count,
      (SELECT COALESCE(SUM(amount), 0) FROM inward_bills WHERE receiving_date = CURRENT_DATE AND status = 'active') as today_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date >= DATE_TRUNC('week', CURRENT_DATE) AND status = 'active') as week_count,
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date >= DATE_TRUNC('month', CURRENT_DATE) AND status = 'active') as month_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid') as total_outstanding,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as total_overdue,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_count,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today_count
  `);

  res.json(result.rows[0]);
}));

// GET /api/inward/:id - Get single bill
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await query(
    `SELECT 
      ib.*, v.code as vendor_code, v.name as vendor_name, v.gstin as vendor_gstin,
      u.full_name as created_by_name
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    WHERE ib.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  // Get payment history for this bill
  const payments = await query(
    `SELECT pd.amount, pd.utr_number, p.payment_date, p.payment_number
     FROM payment_details pd
     JOIN payments p ON pd.payment_id = p.id
     WHERE pd.bill_id = $1
     ORDER BY p.payment_date DESC`,
    [id]
  );

  res.json({
    bill: result.rows[0],
    payments: payments.rows,
  });
}));

// POST /api/inward - Create inward bill (Godown)
router.post('/', authorize('godown', 'owner'), validationRules.createInwardBill, asyncHandler(async (req, res) => {
  const {
    vendor_id, bill_number, invoice_date, receiving_date,
    amount, credit_days, checked_by, remarks, bill_scan_url
  } = req.body;

  // Calculate due date
  const dueDate = new Date(invoice_date);
  dueDate.setDate(dueDate.getDate() + credit_days);

  const result = await query(
    `INSERT INTO inward_bills (
      vendor_id, bill_number, invoice_date, receiving_date,
      amount, credit_days, due_date, checked_by, remarks, bill_scan_url, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *`,
    [vendor_id, bill_number, invoice_date, receiving_date,
     amount, credit_days, dueDate.toISOString().split('T')[0], 
     checked_by, remarks, bill_scan_url, req.user.id]
  );

  // Get vendor name for response
  const vendorResult = await query('SELECT code, name FROM vendors WHERE id = $1', [vendor_id]);

  res.status(201).json({
    message: 'Inward bill created successfully',
    bill: {
      ...result.rows[0],
      vendor_code: vendorResult.rows[0]?.code,
      vendor_name: vendorResult.rows[0]?.name,
    },
  });
}));

// PUT /api/inward/:id - Update inward bill (Owner only after creation)
router.put('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  // Check if bill exists and is active
  const existing = await query(
    'SELECT * FROM inward_bills WHERE id = $1',
    [id]
  );

  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  if (existing.rows[0].status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot update cancelled bill' });
  }

  if (existing.rows[0].payment_status === 'paid') {
    return res.status(400).json({ error: 'Cannot update fully paid bill' });
  }

  const allowedFields = [
    'bill_number', 'invoice_date', 'receiving_date', 'amount',
    'credit_days', 'checked_by', 'remarks', 'bill_scan_url'
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

  // Recalculate due date if invoice_date or credit_days changed
  if (updates.invoice_date || updates.credit_days) {
    const invoiceDate = updates.invoice_date || existing.rows[0].invoice_date;
    const creditDays = updates.credit_days ?? existing.rows[0].credit_days;
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + creditDays);
    setClauses.push(`due_date = $${paramIndex}`);
    values.push(dueDate.toISOString().split('T')[0]);
    paramIndex++;
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Increment version for optimistic locking
  setClauses.push(`version = version + 1`);
  values.push(id);

  const result = await query(
    `UPDATE inward_bills SET ${setClauses.join(', ')}, updated_at = NOW() 
     WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  res.json({
    message: 'Bill updated successfully',
    bill: result.rows[0],
  });
}));

// DELETE /api/inward/:id - Cancel inward bill (Owner only)
router.delete('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Cancellation reason is required' });
  }

  const existing = await query('SELECT * FROM inward_bills WHERE id = $1', [id]);

  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  if (existing.rows[0].paid_amount > 0) {
    return res.status(400).json({ error: 'Cannot cancel bill with payments' });
  }

  const result = await query(
    `UPDATE inward_bills 
     SET status = 'cancelled', cancelled_at = NOW(), 
         cancelled_by = $1, cancel_reason = $2
     WHERE id = $3 RETURNING id, bill_number`,
    [req.user.id, reason, id]
  );

  res.json({
    message: 'Bill cancelled successfully',
    bill: result.rows[0],
  });
}));

module.exports = router;
