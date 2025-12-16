const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules, validators } = require('../middleware/validation.middleware');

router.use(authenticate);

// GET /api/outward - List outward bills
router.get('/', ...validators.pagination(), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const customerId = req.query.customer_id;
  const status = req.query.status;
  const deliveryStatus = req.query.delivery_status;
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;

  let whereClause = "WHERE ob.status != 'cancelled'";
  const params = [];
  let paramIndex = 1;

  if (search) {
    whereClause += ` AND (c.code ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex} OR ob.invoice_number ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  if (customerId) {
    whereClause += ` AND ob.customer_id = $${paramIndex}`;
    params.push(customerId);
    paramIndex++;
  }

  if (status) {
    whereClause += ` AND ob.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (deliveryStatus) {
    whereClause += ` AND ob.delivery_status = $${paramIndex}`;
    params.push(deliveryStatus);
    paramIndex++;
  }

  if (dateFrom) {
    whereClause += ` AND ob.invoice_date >= $${paramIndex}`;
    params.push(dateFrom);
    paramIndex++;
  }

  if (dateTo) {
    whereClause += ` AND ob.invoice_date <= $${paramIndex}`;
    params.push(dateTo);
    paramIndex++;
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM outward_bills ob 
     JOIN customers c ON ob.customer_id = c.id ${whereClause}`,
    params
  );

  const billsResult = await query(
    `SELECT 
      ob.id, ob.invoice_number, ob.invoice_date, ob.amount, ob.collected_amount,
      (ob.amount - ob.collected_amount) as outstanding, ob.credit_days, ob.due_date,
      ob.status, ob.delivery_status, ob.delivery_mode, ob.delivery_person,
      ob.courier_name, ob.tracking_number, ob.dispatched_by, ob.created_at,
      c.id as customer_id, c.code as customer_code, c.name as customer_name,
      u.full_name as created_by_name,
      CASE WHEN ob.due_date < CURRENT_DATE THEN CURRENT_DATE - ob.due_date ELSE 0 END as days_overdue
    FROM outward_bills ob
    JOIN customers c ON ob.customer_id = c.id
    LEFT JOIN users u ON ob.created_by = u.id
    ${whereClause}
    ORDER BY ob.invoice_date DESC, ob.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  res.json({
    data: billsResult.rows,
    pagination: {
      page, limit,
      total: parseInt(countResult.rows[0].count),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    },
  });
}));

// GET /api/outward/today
router.get('/today', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT 
      ob.*, c.code as customer_code, c.name as customer_name,
      u.full_name as created_by_name
    FROM outward_bills ob
    JOIN customers c ON ob.customer_id = c.id
    LEFT JOIN users u ON ob.created_by = u.id
    WHERE ob.invoice_date = CURRENT_DATE AND ob.status != 'cancelled'
    ORDER BY ob.created_at DESC`
  );

  const summary = await query(
    `SELECT 
      COUNT(*) as count,
      COALESCE(SUM(amount), 0) as total_amount,
      COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as delivered_count,
      COUNT(CASE WHEN delivery_status = 'in_transit' THEN 1 END) as transit_count
    FROM outward_bills 
    WHERE invoice_date = CURRENT_DATE AND status != 'cancelled'`
  );

  res.json({
    data: result.rows,
    summary: summary.rows[0],
  });
}));

// GET /api/outward/summary
router.get('/summary', asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND status != 'cancelled') as today_count,
      (SELECT COALESCE(SUM(amount), 0) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND status != 'cancelled') as today_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE delivery_status = 'delivered' AND invoice_date = CURRENT_DATE) as delivered_today,
      (SELECT COUNT(*) FROM outward_bills WHERE delivery_status = 'in_transit') as in_transit,
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date >= DATE_TRUNC('week', CURRENT_DATE) AND status != 'cancelled') as week_count,
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date >= DATE_TRUNC('month', CURRENT_DATE) AND status != 'cancelled') as month_count,
      (SELECT COALESCE(SUM(amount - collected_amount), 0) FROM outward_bills WHERE status != 'cancelled' AND status != 'paid') as total_outstanding
  `);

  res.json(result.rows[0]);
}));

// GET /api/outward/receivables-ageing
router.get('/receivables-ageing', asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN amount - collected_amount ELSE 0 END), 0) as current_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date >= CURRENT_DATE AND status NOT IN ('cancelled', 'paid')) as current_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 15 
        THEN amount - collected_amount ELSE 0 END), 0) as days_15_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 15 AND status NOT IN ('cancelled', 'paid')) as days_15_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 15 AND due_date >= CURRENT_DATE - 21 
        THEN amount - collected_amount ELSE 0 END), 0) as days_21_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 15 AND due_date >= CURRENT_DATE - 21 AND status NOT IN ('cancelled', 'paid')) as days_21_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 21 AND due_date >= CURRENT_DATE - 30 
        THEN amount - collected_amount ELSE 0 END), 0) as days_30_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 21 AND due_date >= CURRENT_DATE - 30 AND status NOT IN ('cancelled', 'paid')) as days_30_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 
        THEN amount - collected_amount ELSE 0 END), 0) as days_30_plus_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 30 AND status NOT IN ('cancelled', 'paid')) as days_30_plus_count
    FROM outward_bills WHERE status NOT IN ('cancelled', 'paid')
  `);

  res.json(result.rows[0]);
}));

// GET /api/outward/overdue
router.get('/overdue', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 0; // 0 = all overdue, 15, 21, 30
  
  let whereClause = "WHERE ob.due_date < CURRENT_DATE AND ob.status NOT IN ('cancelled', 'paid')";
  
  if (days === 15) {
    whereClause += " AND ob.due_date >= CURRENT_DATE - 15";
  } else if (days === 21) {
    whereClause += " AND ob.due_date < CURRENT_DATE - 15 AND ob.due_date >= CURRENT_DATE - 21";
  } else if (days === 30) {
    whereClause += " AND ob.due_date < CURRENT_DATE - 21 AND ob.due_date >= CURRENT_DATE - 30";
  } else if (days > 30) {
    whereClause += " AND ob.due_date < CURRENT_DATE - 30";
  }

  const result = await query(
    `SELECT 
      ob.*, c.code as customer_code, c.name as customer_name, c.whatsapp,
      u.full_name as dispatched_by_name,
      CURRENT_DATE - ob.due_date as days_overdue
    FROM outward_bills ob
    JOIN customers c ON ob.customer_id = c.id
    LEFT JOIN users u ON ob.created_by = u.id
    ${whereClause}
    ORDER BY ob.due_date ASC`
  );

  res.json(result.rows);
}));

// GET /api/outward/:id
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await query(
    `SELECT 
      ob.*, c.code as customer_code, c.name as customer_name, 
      c.whatsapp as customer_whatsapp, c.gstin as customer_gstin,
      u.full_name as created_by_name
    FROM outward_bills ob
    JOIN customers c ON ob.customer_id = c.id
    LEFT JOIN users u ON ob.created_by = u.id
    WHERE ob.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  res.json(result.rows[0]);
}));

// POST /api/outward - Create dispatch (Godown)
router.post('/', authorize('godown', 'owner'), validationRules.createOutwardBill, asyncHandler(async (req, res) => {
  const {
    customer_id, invoice_number, invoice_date, amount, credit_days,
    dispatched_by, delivery_mode, delivery_person, courier_name,
    tracking_number, remarks
  } = req.body;

  // Calculate due date
  const dueDate = new Date(invoice_date);
  dueDate.setDate(dueDate.getDate() + credit_days);

  // Set initial delivery status based on mode
  let deliveryStatus = 'pending';
  if (delivery_mode === 'pickup') {
    deliveryStatus = 'delivered';
  } else if (delivery_person || courier_name) {
    deliveryStatus = 'dispatched';
  }

  const result = await query(
    `INSERT INTO outward_bills (
      customer_id, invoice_number, invoice_date, amount, credit_days, due_date,
      dispatched_by, delivery_mode, delivery_person, courier_name, tracking_number,
      delivery_status, remarks, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [customer_id, invoice_number, invoice_date, amount, credit_days,
     dueDate.toISOString().split('T')[0], dispatched_by, delivery_mode,
     delivery_person, courier_name, tracking_number, deliveryStatus, remarks, req.user.id]
  );

  const customerResult = await query('SELECT code, name FROM customers WHERE id = $1', [customer_id]);

  res.status(201).json({
    message: 'Dispatch created successfully',
    bill: {
      ...result.rows[0],
      customer_code: customerResult.rows[0]?.code,
      customer_name: customerResult.rows[0]?.name,
    },
  });
}));

// PATCH /api/outward/:id/delivery-status - Update delivery status
router.patch('/:id/delivery-status', authorize('godown', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { delivery_status, tracking_number, delivery_person, delivered_at } = req.body;

  const validStatuses = ['pending', 'dispatched', 'in_transit', 'delivered', 'returned'];
  if (!validStatuses.includes(delivery_status)) {
    return res.status(400).json({ error: 'Invalid delivery status' });
  }

  const updates = ['delivery_status = $1'];
  const values = [delivery_status];
  let paramIndex = 2;

  if (tracking_number !== undefined) {
    updates.push(`tracking_number = $${paramIndex}`);
    values.push(tracking_number);
    paramIndex++;
  }

  if (delivery_person !== undefined) {
    updates.push(`delivery_person = $${paramIndex}`);
    values.push(delivery_person);
    paramIndex++;
  }

  if (delivery_status === 'delivered') {
    updates.push(`delivered_at = $${paramIndex}`);
    values.push(delivered_at || new Date());
    paramIndex++;
  }

  values.push(id);

  const result = await query(
    `UPDATE outward_bills SET ${updates.join(', ')}, updated_at = NOW()
     WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  res.json({
    message: 'Delivery status updated',
    bill: result.rows[0],
  });
}));

// PUT /api/outward/:id - Update outward bill (Owner only)
router.put('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const allowedFields = [
    'invoice_number', 'invoice_date', 'amount', 'credit_days',
    'dispatched_by', 'delivery_mode', 'delivery_person', 'courier_name',
    'tracking_number', 'remarks'
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
    `UPDATE outward_bills SET ${setClauses.join(', ')}, updated_at = NOW() 
     WHERE id = $${paramIndex} AND status != 'cancelled' RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found or cancelled' });
  }

  res.json({ message: 'Bill updated', bill: result.rows[0] });
}));

// DELETE /api/outward/:id - Cancel outward bill (Owner only)
router.delete('/:id', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Cancellation reason is required' });
  }

  const existing = await query('SELECT * FROM outward_bills WHERE id = $1', [id]);

  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  if (existing.rows[0].collected_amount > 0) {
    return res.status(400).json({ error: 'Cannot cancel bill with collections' });
  }

  const result = await query(
    `UPDATE outward_bills 
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 RETURNING id, invoice_number`,
    [id]
  );

  res.json({ message: 'Bill cancelled', bill: result.rows[0] });
}));

module.exports = router;
