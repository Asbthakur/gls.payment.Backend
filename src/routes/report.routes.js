const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

router.use(authenticate);

// GET /api/reports/payables-ageing - Vendor-wise payables ageing
router.get('/payables-ageing', authorize('purchase', 'accounts', 'owner'), asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      v.id as vendor_id, v.code as vendor_code, v.name as vendor_name,
      COALESCE(SUM(CASE WHEN ib.due_date >= CURRENT_DATE THEN ib.amount - ib.paid_amount ELSE 0 END), 0) as current_amount,
      COALESCE(SUM(CASE WHEN ib.due_date < CURRENT_DATE AND ib.due_date >= CURRENT_DATE - 30 THEN ib.amount - ib.paid_amount ELSE 0 END), 0) as days_1_30,
      COALESCE(SUM(CASE WHEN ib.due_date < CURRENT_DATE - 30 AND ib.due_date >= CURRENT_DATE - 60 THEN ib.amount - ib.paid_amount ELSE 0 END), 0) as days_31_60,
      COALESCE(SUM(CASE WHEN ib.due_date < CURRENT_DATE - 60 AND ib.due_date >= CURRENT_DATE - 90 THEN ib.amount - ib.paid_amount ELSE 0 END), 0) as days_61_90,
      COALESCE(SUM(CASE WHEN ib.due_date < CURRENT_DATE - 90 THEN ib.amount - ib.paid_amount ELSE 0 END), 0) as days_90_plus,
      COALESCE(SUM(ib.amount - ib.paid_amount), 0) as total_outstanding
    FROM vendors v
    LEFT JOIN inward_bills ib ON v.id = ib.vendor_id AND ib.status = 'active' AND ib.payment_status != 'paid'
    WHERE v.is_active = true
    GROUP BY v.id, v.code, v.name
    HAVING SUM(ib.amount - ib.paid_amount) > 0
    ORDER BY total_outstanding DESC
  `);

  // Summary totals
  const summary = await query(`
    SELECT 
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN amount - paid_amount ELSE 0 END), 0) as current_total,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 30 THEN amount - paid_amount ELSE 0 END), 0) as days_1_30_total,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60 THEN amount - paid_amount ELSE 0 END), 0) as days_31_60_total,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90 THEN amount - paid_amount ELSE 0 END), 0) as days_61_90_total,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 90 THEN amount - paid_amount ELSE 0 END), 0) as days_90_plus_total,
      COALESCE(SUM(amount - paid_amount), 0) as grand_total
    FROM inward_bills WHERE status = 'active' AND payment_status != 'paid'
  `);

  res.json({
    data: result.rows,
    summary: summary.rows[0],
  });
}));

// GET /api/reports/receivables-ageing - Customer-wise receivables ageing
router.get('/receivables-ageing', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      c.id as customer_id, c.code as customer_code, c.name as customer_name,
      COALESCE(SUM(CASE WHEN ob.due_date >= CURRENT_DATE THEN ob.amount - ob.collected_amount ELSE 0 END), 0) as current_amount,
      COALESCE(SUM(CASE WHEN ob.due_date < CURRENT_DATE AND ob.due_date >= CURRENT_DATE - 15 THEN ob.amount - ob.collected_amount ELSE 0 END), 0) as days_1_15,
      COALESCE(SUM(CASE WHEN ob.due_date < CURRENT_DATE - 15 AND ob.due_date >= CURRENT_DATE - 21 THEN ob.amount - ob.collected_amount ELSE 0 END), 0) as days_16_21,
      COALESCE(SUM(CASE WHEN ob.due_date < CURRENT_DATE - 21 AND ob.due_date >= CURRENT_DATE - 30 THEN ob.amount - ob.collected_amount ELSE 0 END), 0) as days_22_30,
      COALESCE(SUM(CASE WHEN ob.due_date < CURRENT_DATE - 30 THEN ob.amount - ob.collected_amount ELSE 0 END), 0) as days_30_plus,
      COALESCE(SUM(ob.amount - ob.collected_amount), 0) as total_outstanding
    FROM customers c
    LEFT JOIN outward_bills ob ON c.id = ob.customer_id AND ob.status NOT IN ('cancelled', 'paid')
    WHERE c.is_active = true
    GROUP BY c.id, c.code, c.name
    HAVING SUM(ob.amount - ob.collected_amount) > 0
    ORDER BY total_outstanding DESC
  `);

  res.json({ data: result.rows });
}));

// GET /api/reports/vendor-outstanding - Detailed vendor outstanding
router.get('/vendor-outstanding', authorize('purchase', 'accounts', 'owner'), asyncHandler(async (req, res) => {
  const vendorId = req.query.vendor_id;

  let whereClause = "WHERE ib.status = 'active' AND ib.payment_status != 'paid'";
  const params = [];

  if (vendorId) {
    whereClause += ' AND v.id = $1';
    params.push(vendorId);
  }

  const result = await query(
    `SELECT 
      v.code as vendor_code, v.name as vendor_name,
      ib.bill_number, ib.invoice_date, ib.amount, ib.paid_amount,
      (ib.amount - ib.paid_amount) as outstanding, ib.due_date,
      CASE WHEN ib.due_date < CURRENT_DATE THEN CURRENT_DATE - ib.due_date ELSE 0 END as days_overdue
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    ${whereClause}
    ORDER BY v.name, ib.due_date`,
    params
  );

  res.json({ data: result.rows });
}));

// GET /api/reports/customer-outstanding - Detailed customer outstanding
router.get('/customer-outstanding', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const customerId = req.query.customer_id;

  let whereClause = "WHERE ob.status NOT IN ('cancelled', 'paid')";
  const params = [];

  if (customerId) {
    whereClause += ' AND c.id = $1';
    params.push(customerId);
  }

  const result = await query(
    `SELECT 
      c.code as customer_code, c.name as customer_name, c.whatsapp,
      ob.invoice_number, ob.invoice_date, ob.amount, ob.collected_amount,
      (ob.amount - ob.collected_amount) as outstanding, ob.due_date,
      u.full_name as dispatched_by,
      CASE WHEN ob.due_date < CURRENT_DATE THEN CURRENT_DATE - ob.due_date ELSE 0 END as days_overdue
    FROM outward_bills ob
    JOIN customers c ON ob.customer_id = c.id
    LEFT JOIN users u ON ob.created_by = u.id
    ${whereClause}
    ORDER BY c.name, ob.due_date`,
    params
  );

  res.json({ data: result.rows });
}));

// GET /api/reports/payment-history - Payment history report
router.get('/payment-history', authorize('purchase', 'accounts', 'owner'), asyncHandler(async (req, res) => {
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;
  const vendorId = req.query.vendor_id;

  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (dateFrom) {
    whereClause += ` AND p.payment_date >= $${paramIndex}`;
    params.push(dateFrom);
    paramIndex++;
  }

  if (dateTo) {
    whereClause += ` AND p.payment_date <= $${paramIndex}`;
    params.push(dateTo);
    paramIndex++;
  }

  if (vendorId) {
    whereClause += ` AND ib.vendor_id = $${paramIndex}`;
    params.push(vendorId);
    paramIndex++;
  }

  const result = await query(
    `SELECT 
      p.payment_date, p.payment_number,
      v.code as vendor_code, v.name as vendor_name,
      ib.bill_number, pd.amount, pd.utr_number,
      ba.bank_name,
      u.full_name as proposed_by
    FROM payment_details pd
    JOIN payments p ON pd.payment_id = p.id
    JOIN inward_bills ib ON pd.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
    LEFT JOIN proposal_items pi ON pd.proposal_item_id = pi.id
    LEFT JOIN proposals pr ON pi.proposal_id = pr.id
    LEFT JOIN users u ON pr.created_by = u.id
    ${whereClause}
    ORDER BY p.payment_date DESC, v.name`,
    params
  );

  // Summary
  const summaryResult = await query(
    `SELECT 
      COUNT(DISTINCT p.id) as payment_count,
      COUNT(DISTINCT ib.vendor_id) as vendor_count,
      COUNT(pd.id) as bill_count,
      COALESCE(SUM(pd.amount), 0) as total_amount
    FROM payment_details pd
    JOIN payments p ON pd.payment_id = p.id
    JOIN inward_bills ib ON pd.bill_id = ib.id
    ${whereClause}`,
    params
  );

  res.json({
    data: result.rows,
    summary: summaryResult.rows[0],
  });
}));

// GET /api/reports/daily-summary - Daily transaction summary
router.get('/daily-summary', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const summary = await query(
    `SELECT 
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date = $1 AND status = 'active') as inward_count,
      (SELECT COALESCE(SUM(amount), 0) FROM inward_bills WHERE receiving_date = $1 AND status = 'active') as inward_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date = $1 AND status != 'cancelled') as outward_count,
      (SELECT COALESCE(SUM(amount), 0) FROM outward_bills WHERE invoice_date = $1 AND status != 'cancelled') as outward_amount,
      (SELECT COUNT(*) FROM payments WHERE payment_date = $1) as payment_count,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date = $1) as payment_amount,
      (SELECT COUNT(DISTINCT ib.vendor_id) FROM payment_details pd JOIN payments p ON pd.payment_id = p.id JOIN inward_bills ib ON pd.bill_id = ib.id WHERE p.payment_date = $1) as vendors_paid
    `,
    [date]
  );

  res.json({
    date,
    summary: summary.rows[0],
  });
}));

// GET /api/reports/cash-flow - Cash flow projection
router.get('/cash-flow', authorize('owner'), asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;

  // Generate date range
  const cashFlow = await query(`
    WITH dates AS (
      SELECT generate_series(CURRENT_DATE, CURRENT_DATE + $1, '1 day'::interval)::date as date
    )
    SELECT 
      d.date,
      COALESCE((SELECT SUM(amount - collected_amount) FROM outward_bills WHERE due_date = d.date AND status NOT IN ('cancelled', 'paid')), 0) as expected_inflow,
      COALESCE((SELECT SUM(amount - paid_amount) FROM inward_bills WHERE due_date = d.date AND status = 'active' AND payment_status != 'paid'), 0) as expected_outflow
    FROM dates d
    ORDER BY d.date
  `, [days]);

  res.json({
    data: cashFlow.rows,
    days,
  });
}));

// GET /api/reports/audit-log - Audit trail
router.get('/audit-log', authorize('owner'), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  const entity = req.query.entity;
  const action = req.query.action;

  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (entity) {
    whereClause += ` AND entity_type = $${paramIndex}`;
    params.push(entity);
    paramIndex++;
  }

  if (action) {
    whereClause += ` AND action = $${paramIndex}`;
    params.push(action);
    paramIndex++;
  }

  const result = await query(
    `SELECT al.*, u.full_name as user_name
     FROM audit_log al
     LEFT JOIN users u ON al.user_id = u.id
     ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  res.json({
    data: result.rows,
    pagination: { page, limit },
  });
}));

module.exports = router;
