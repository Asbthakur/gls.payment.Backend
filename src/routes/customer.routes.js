const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules, validators } = require('../middleware/validation.middleware');

router.use(authenticate);

// GET /api/customers - List all customers
router.get('/', ...validators.pagination(), asyncHandler(async (req, res) => {
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const sortBy = req.query.sortBy || 'name';
  const sortOrder = req.query.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const activeOnly = req.query.active !== 'false';

  let whereClause = activeOnly ? 'WHERE is_active = true' : '';
  const params = [];
  
  if (search) {
    whereClause += activeOnly ? ' AND' : ' WHERE';
    whereClause += ` (code ILIKE $1 OR name ILIKE $1 OR city ILIKE $1)`;
    params.push(`%${search}%`);
  }

  const countResult = await query(`SELECT COUNT(*) FROM customers ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count);

  const customersResult = await query(
    `SELECT 
      id, code, name, contact_person, phone, mobile, whatsapp, email, gstin,
      city, state, default_credit_days, credit_limit, is_active, created_at
    FROM customers 
    ${whereClause}
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.json({
    data: customersResult.rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/customers/dropdown
router.get('/dropdown', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, code, name, default_credit_days 
     FROM customers WHERE is_active = true ORDER BY name`
  );
  res.json(result.rows);
}));

// GET /api/customers/:id
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customerResult = await query(`SELECT * FROM customers WHERE id = $1`, [id]);
  if (customerResult.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const outstandingResult = await query(
    `SELECT 
      COUNT(id) as total_bills,
      COALESCE(SUM(amount), 0) as total_amount,
      COALESCE(SUM(amount - collected_amount), 0) as outstanding_amount,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN amount - collected_amount ELSE 0 END), 0) as overdue_amount
    FROM outward_bills 
    WHERE customer_id = $1 AND status != 'cancelled' AND status != 'paid'`,
    [id]
  );

  res.json({
    customer: customerResult.rows[0],
    summary: outstandingResult.rows[0],
  });
}));

// GET /api/customers/:id/bills
router.get('/:id/bills', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const status = req.query.status;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  let whereClause = "WHERE customer_id = $1 AND status != 'cancelled'";
  const params = [id];

  if (status && status !== 'all') {
    whereClause += ` AND status = $2`;
    params.push(status);
  }

  const billsResult = await query(
    `SELECT 
      id, invoice_number, invoice_date, amount, collected_amount,
      (amount - collected_amount) as outstanding, credit_days, due_date,
      status, delivery_status, dispatched_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN CURRENT_DATE - due_date ELSE 0 END as days_overdue
    FROM outward_bills 
    ${whereClause}
    ORDER BY due_date ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.json({ data: billsResult.rows, pagination: { page, limit } });
}));

// GET /api/customers/:id/receivables-ageing
router.get('/:id/receivables-ageing', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const ageingResult = await query(
    `SELECT 
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN amount - collected_amount ELSE 0 END), 0) as current_amount,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 15 
        THEN amount - collected_amount ELSE 0 END), 0) as days_1_15,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 15 AND due_date >= CURRENT_DATE - 21 
        THEN amount - collected_amount ELSE 0 END), 0) as days_16_21,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 21 AND due_date >= CURRENT_DATE - 30 
        THEN amount - collected_amount ELSE 0 END), 0) as days_22_30,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 
        THEN amount - collected_amount ELSE 0 END), 0) as days_30_plus
    FROM outward_bills 
    WHERE customer_id = $1 AND status != 'cancelled' AND status != 'paid'`,
    [id]
  );

  res.json(ageingResult.rows[0]);
}));

// POST /api/customers
router.post('/', authorize('owner', 'accounts'), validationRules.createCustomer, asyncHandler(async (req, res) => {
  const {
    code, name, contact_person, phone, mobile, whatsapp, email, gstin,
    address, city, state, pincode, default_credit_days, credit_limit
  } = req.body;

  const result = await query(
    `INSERT INTO customers (
      code, name, contact_person, phone, mobile, whatsapp, email, gstin,
      address, city, state, pincode, default_credit_days, credit_limit, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *`,
    [code, name, contact_person, phone, mobile, whatsapp, email, gstin,
     address, city, state, pincode, default_credit_days || 30, credit_limit, req.user.id]
  );

  res.status(201).json({ message: 'Customer created', customer: result.rows[0] });
}));

// PUT /api/customers/:id
router.put('/:id', authorize('owner', 'accounts'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const allowedFields = [
    'name', 'contact_person', 'phone', 'mobile', 'whatsapp', 'email', 'gstin',
    'address', 'city', 'state', 'pincode', 'default_credit_days', 'credit_limit', 'is_active'
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
    `UPDATE customers SET ${setClauses.join(', ')}, updated_at = NOW() 
     WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json({ message: 'Customer updated', customer: result.rows[0] });
}));

// DELETE /api/customers/:id
router.delete('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const outstandingResult = await query(
    `SELECT COUNT(*) FROM outward_bills 
     WHERE customer_id = $1 AND status != 'cancelled' AND status != 'paid'`,
    [id]
  );

  if (parseInt(outstandingResult.rows[0].count) > 0) {
    return res.status(400).json({ 
      error: 'Cannot delete customer with outstanding bills',
      outstandingCount: outstandingResult.rows[0].count
    });
  }

  const result = await query(
    `UPDATE customers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json({ message: 'Customer deactivated', customer: result.rows[0] });
}));

module.exports = router;
