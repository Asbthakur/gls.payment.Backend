const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

router.use(authenticate);

// GET /api/dashboard/godown - Godown dashboard stats
router.get('/godown', authorize('godown', 'owner'), asyncHandler(async (req, res) => {
  const stats = await query(`
    SELECT 
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date = CURRENT_DATE AND status = 'active') as inward_today,
      (SELECT COALESCE(SUM(amount), 0) FROM inward_bills WHERE receiving_date = CURRENT_DATE AND status = 'active') as inward_today_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND status != 'cancelled') as outward_today,
      (SELECT COALESCE(SUM(amount), 0) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND status != 'cancelled') as outward_today_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND delivery_status = 'delivered') as delivered_today,
      (SELECT COUNT(*) FROM outward_bills WHERE delivery_status = 'in_transit') as in_transit,
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date >= DATE_TRUNC('week', CURRENT_DATE) AND status = 'active') as inward_week,
      (SELECT COUNT(*) FROM inward_bills WHERE receiving_date >= DATE_TRUNC('month', CURRENT_DATE) AND status = 'active') as inward_month
  `);

  // Recent inward entries
  const recentInward = await query(
    `SELECT ib.*, v.code as vendor_code, v.name as vendor_name, u.full_name as created_by_name
     FROM inward_bills ib
     JOIN vendors v ON ib.vendor_id = v.id
     LEFT JOIN users u ON ib.created_by = u.id
     WHERE ib.receiving_date = CURRENT_DATE AND ib.status = 'active'
     ORDER BY ib.created_at DESC LIMIT 10`
  );

  // Recent outward entries
  const recentOutward = await query(
    `SELECT ob.*, c.code as customer_code, c.name as customer_name, u.full_name as created_by_name
     FROM outward_bills ob
     JOIN customers c ON ob.customer_id = c.id
     LEFT JOIN users u ON ob.created_by = u.id
     WHERE ob.invoice_date = CURRENT_DATE AND ob.status != 'cancelled'
     ORDER BY ob.created_at DESC LIMIT 10`
  );

  res.json({
    stats: stats.rows[0],
    recentInward: recentInward.rows,
    recentOutward: recentOutward.rows,
  });
}));

// GET /api/dashboard/purchase - Purchase dashboard stats
router.get('/purchase', authorize('purchase', 'owner'), asyncHandler(async (req, res) => {
  const stats = await query(`
    SELECT 
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7) as due_week_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7) as due_week_amount,
      (SELECT COUNT(*) FROM proposal_items WHERE status = 'carry_forward') as carry_forward_count,
      (SELECT COALESCE(SUM(proposed_amount), 0) FROM proposal_items WHERE status = 'carry_forward') as carry_forward_amount,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date = CURRENT_DATE - 1) as paid_yesterday,
      (SELECT COUNT(DISTINCT ib.vendor_id) FROM payment_details pd JOIN inward_bills ib ON pd.bill_id = ib.id JOIN payments p ON pd.payment_id = p.id WHERE p.payment_date = CURRENT_DATE - 1) as paid_yesterday_vendors,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date >= DATE_TRUNC('month', CURRENT_DATE)) as paid_month
  `);

  // My proposals
  const myProposals = await query(
    `SELECT p.*, 
      (SELECT COUNT(*) FROM proposal_items WHERE proposal_id = p.id) as item_count
     FROM proposals p
     WHERE p.created_by = $1
     ORDER BY p.created_at DESC LIMIT 5`,
    [req.user.id]
  );

  res.json({
    stats: stats.rows[0],
    myProposals: myProposals.rows,
  });
}));

// GET /api/dashboard/accounts - Accounts dashboard stats
router.get('/accounts', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const stats = await query(`
    SELECT 
      (SELECT COUNT(*) FROM proposals WHERE status = 'submitted') as pending_validation,
      (SELECT COALESCE(SUM(total_amount), 0) FROM proposals WHERE status = 'submitted') as pending_validation_amount,
      (SELECT COUNT(*) FROM proposal_items WHERE accounts_status = 'approved' AND owner_status = 'pending') as approved_count,
      (SELECT COALESCE(SUM(accounts_amount), 0) FROM proposal_items WHERE accounts_status = 'approved' AND owner_status = 'pending') as approved_amount,
      (SELECT COUNT(*) FROM proposal_items WHERE accounts_status = 'held') as on_hold_count,
      (SELECT COALESCE(SUM(accounts_amount), 0) FROM proposal_items WHERE accounts_status = 'held') as on_hold_amount,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date = CURRENT_DATE AND status = 'confirmed') as paid_today,
      (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_utr_count
  `);

  // Receivables ageing
  const receivablesAgeing = await query(`
    SELECT 
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN amount - collected_amount ELSE 0 END), 0) as current_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date >= CURRENT_DATE AND status NOT IN ('cancelled', 'paid')) as current_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 15 THEN amount - collected_amount ELSE 0 END), 0) as days_15_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 15 AND status NOT IN ('cancelled', 'paid')) as days_15_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 15 AND due_date >= CURRENT_DATE - 21 THEN amount - collected_amount ELSE 0 END), 0) as days_21_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 15 AND due_date >= CURRENT_DATE - 21 AND status NOT IN ('cancelled', 'paid')) as days_21_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 21 AND due_date >= CURRENT_DATE - 30 THEN amount - collected_amount ELSE 0 END), 0) as days_30_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 21 AND due_date >= CURRENT_DATE - 30 AND status NOT IN ('cancelled', 'paid')) as days_30_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - 30 THEN amount - collected_amount ELSE 0 END), 0) as days_30_plus_amount,
      (SELECT COUNT(*) FROM outward_bills WHERE due_date < CURRENT_DATE - 30 AND status NOT IN ('cancelled', 'paid')) as days_30_plus_count
    FROM outward_bills WHERE status NOT IN ('cancelled', 'paid')
  `);

  // Pending proposals for validation
  const pendingProposals = await query(
    `SELECT p.*, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM proposal_items WHERE proposal_id = p.id) as item_count
     FROM proposals p
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.status = 'submitted'
     ORDER BY p.created_at ASC LIMIT 5`
  );

  res.json({
    stats: stats.rows[0],
    receivablesAgeing: receivablesAgeing.rows[0],
    pendingProposals: pendingProposals.rows,
  });
}));

// GET /api/dashboard/owner - Owner dashboard stats
router.get('/owner', authorize('owner'), asyncHandler(async (req, res) => {
  const cashPosition = await query(`
    SELECT 
      (SELECT COALESCE(SUM(amount - collected_amount), 0) FROM outward_bills WHERE due_date <= CURRENT_DATE + 7 AND status NOT IN ('cancelled', 'paid')) as expected_inflow,
      (SELECT COALESCE(SUM(owner_amount), 0) FROM proposal_items WHERE owner_status = 'approved' AND status NOT IN ('paid', 'owner_rejected')) as pending_payables,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_payables
  `);

  const stats = await query(`
    SELECT 
      (SELECT COUNT(*) FROM proposals WHERE status IN ('under_review', 'approved', 'partial_approved')) as pending_approval,
      (SELECT COALESCE(SUM(total_amount), 0) FROM proposals WHERE status IN ('under_review', 'approved', 'partial_approved')) as pending_approval_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today_amount,
      (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7) as due_week_count,
      (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7) as due_week_amount
  `);

  // Pending proposals for owner approval
  const pendingProposals = await query(
    `SELECT p.*, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM proposal_items WHERE proposal_id = p.id AND accounts_status = 'approved') as approved_items,
      (SELECT COALESCE(SUM(accounts_amount), 0) FROM proposal_items WHERE proposal_id = p.id AND accounts_status = 'approved') as approved_amount
     FROM proposals p
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.status IN ('under_review', 'approved', 'partial_approved')
     ORDER BY p.created_at ASC LIMIT 5`
  );

  // Customer receivables (overdue)
  const overdueReceivables = await query(
    `SELECT ob.*, c.code as customer_code, c.name as customer_name, c.whatsapp,
      u.full_name as dispatched_by_name,
      CURRENT_DATE - ob.due_date as days_overdue
     FROM outward_bills ob
     JOIN customers c ON ob.customer_id = c.id
     LEFT JOIN users u ON ob.created_by = u.id
     WHERE ob.due_date < CURRENT_DATE AND ob.status NOT IN ('cancelled', 'paid')
     ORDER BY ob.due_date ASC LIMIT 10`
  );

  res.json({
    cashPosition: cashPosition.rows[0],
    stats: stats.rows[0],
    pendingProposals: pendingProposals.rows,
    overdueReceivables: overdueReceivables.rows,
  });
}));

// GET /api/dashboard/summary - Quick summary for header
router.get('/summary', asyncHandler(async (req, res) => {
  const { role } = req.user;

  let summary = {};

  if (role === 'godown' || role === 'owner') {
    const godownStats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM inward_bills WHERE receiving_date = CURRENT_DATE AND status = 'active') as inward_today,
        (SELECT COUNT(*) FROM outward_bills WHERE invoice_date = CURRENT_DATE AND status != 'cancelled') as outward_today
    `);
    summary.godown = godownStats.rows[0];
  }

  if (role === 'purchase' || role === 'owner') {
    const purchaseStats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date < CURRENT_DATE) as overdue,
        (SELECT COUNT(*) FROM inward_bills WHERE status = 'active' AND payment_status != 'paid' AND due_date = CURRENT_DATE) as due_today
    `);
    summary.purchase = purchaseStats.rows[0];
  }

  if (role === 'accounts' || role === 'owner') {
    const accountsStats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM proposals WHERE status = 'submitted') as pending_validation,
        (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_utr
    `);
    summary.accounts = accountsStats.rows[0];
  }

  if (role === 'owner') {
    const ownerStats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM proposals WHERE status IN ('under_review', 'approved', 'partial_approved')) as pending_approval
    `);
    summary.owner = ownerStats.rows[0];
  }

  res.json(summary);
}));

module.exports = router;
