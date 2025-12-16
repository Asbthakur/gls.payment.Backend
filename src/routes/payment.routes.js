const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules } = require('../middleware/validation.middleware');

router.use(authenticate);

// GET /api/payments - List payments
router.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const status = req.query.status;
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;

  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND p.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

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

  const paymentsResult = await query(
    `SELECT 
      p.*, ba.bank_name, ba.account_number,
      pr.proposal_number,
      (SELECT COUNT(*) FROM payment_details WHERE payment_id = p.id) as vendor_count
    FROM payments p
    LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
    LEFT JOIN proposals pr ON p.proposal_id = pr.id
    ${whereClause}
    ORDER BY p.payment_date DESC, p.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  res.json({
    data: paymentsResult.rows,
    pagination: { page, limit },
  });
}));

// GET /api/payments/by-date/:date - Payments by date
router.get('/by-date/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;

  const paymentsResult = await query(
    `SELECT 
      p.*, ba.bank_name,
      (SELECT COUNT(*) FROM payment_details WHERE payment_id = p.id) as vendor_count,
      (SELECT COUNT(DISTINCT pd.id) FROM payment_details pd 
       JOIN inward_bills ib ON pd.bill_id = ib.id WHERE pd.payment_id = p.id) as bill_count
    FROM payments p
    LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
    WHERE p.payment_date = $1
    ORDER BY p.created_at DESC`,
    [date]
  );

  // Get details for each payment
  const payments = [];
  for (const payment of paymentsResult.rows) {
    const detailsResult = await query(
      `SELECT 
        pd.*, ib.bill_number, ib.invoice_date,
        v.code as vendor_code, v.name as vendor_name, v.account_number, v.ifsc_code,
        u.full_name as proposed_by
      FROM payment_details pd
      JOIN inward_bills ib ON pd.bill_id = ib.id
      JOIN vendors v ON ib.vendor_id = v.id
      LEFT JOIN proposal_items pi ON pd.proposal_item_id = pi.id
      LEFT JOIN proposals pr ON pi.proposal_id = pr.id
      LEFT JOIN users u ON pr.created_by = u.id
      WHERE pd.payment_id = $1
      ORDER BY v.name`,
      [payment.id]
    );
    payments.push({ ...payment, details: detailsResult.rows });
  }

  // Summary
  const summaryResult = await query(
    `SELECT 
      COUNT(DISTINCT p.id) as payment_count,
      COALESCE(SUM(p.total_amount), 0) as total_amount,
      COUNT(DISTINCT ib.vendor_id) as vendor_count,
      COUNT(DISTINCT pd.bill_id) as bill_count
    FROM payments p
    JOIN payment_details pd ON p.id = pd.payment_id
    JOIN inward_bills ib ON pd.bill_id = ib.id
    WHERE p.payment_date = $1`,
    [date]
  );

  res.json({
    date,
    payments,
    summary: summaryResult.rows[0],
  });
}));

// GET /api/payments/pending-utr - Payments pending UTR entry
router.get('/pending-utr', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT 
      p.*, ba.bank_name, ba.account_number as company_account,
      (SELECT COUNT(*) FROM payment_details WHERE payment_id = p.id AND (utr_number IS NULL OR utr_number = '')) as pending_count,
      (SELECT COUNT(*) FROM payment_details WHERE payment_id = p.id AND utr_number IS NOT NULL AND utr_number != '') as completed_count
    FROM payments p
    LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
    WHERE p.status IN ('pending', 'processed')
    ORDER BY p.payment_date DESC`
  );

  res.json(result.rows);
}));

// GET /api/payments/:id - Get payment with details
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const paymentResult = await query(
    `SELECT p.*, ba.bank_name, ba.account_number as company_account, ba.ifsc_code as company_ifsc
     FROM payments p
     LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
     WHERE p.id = $1`,
    [id]
  );

  if (paymentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const detailsResult = await query(
    `SELECT 
      pd.*, ib.bill_number, ib.invoice_date, ib.amount as bill_amount,
      v.code as vendor_code, v.name as vendor_name,
      v.account_number as vendor_account, v.ifsc_code as vendor_ifsc, v.bank_name as vendor_bank
    FROM payment_details pd
    JOIN inward_bills ib ON pd.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    WHERE pd.payment_id = $1
    ORDER BY v.name`,
    [id]
  );

  res.json({
    payment: paymentResult.rows[0],
    details: detailsResult.rows,
  });
}));

// POST /api/payments/create-from-proposal - Create payment batch from approved proposal
router.post('/create-from-proposal', authorize('accounts', 'owner'), asyncHandler(async (req, res) => {
  const { proposal_id, bank_account_id } = req.body;

  if (!proposal_id || !bank_account_id) {
    return res.status(400).json({ error: 'proposal_id and bank_account_id are required' });
  }

  const result = await transaction(async (client) => {
    // Verify proposal is approved
    const proposalResult = await client.query(
      `SELECT * FROM proposals WHERE id = $1 AND status IN ('approved', 'partial_approved')`,
      [proposal_id]
    );

    if (proposalResult.rows.length === 0) {
      throw new Error('Proposal not found or not approved');
    }

    // Get approved items
    const itemsResult = await client.query(
      `SELECT pi.*, ib.vendor_id 
       FROM proposal_items pi
       JOIN inward_bills ib ON pi.bill_id = ib.id
       WHERE pi.proposal_id = $1 AND pi.owner_status = 'approved'`,
      [proposal_id]
    );

    if (itemsResult.rows.length === 0) {
      throw new Error('No approved items found');
    }

    // Generate payment number
    const numberResult = await client.query('SELECT generate_payment_number() as payment_number');
    const paymentNumber = numberResult.rows[0].payment_number;

    // Calculate total
    const totalAmount = itemsResult.rows.reduce((sum, item) => sum + parseFloat(item.owner_amount), 0);

    // Create payment
    const paymentResult = await client.query(
      `INSERT INTO payments (payment_number, proposal_id, payment_date, total_amount, bank_account_id, created_by)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, $5) RETURNING *`,
      [paymentNumber, proposal_id, totalAmount, bank_account_id, req.user.id]
    );
    const payment = paymentResult.rows[0];

    // Create payment details
    for (const item of itemsResult.rows) {
      await client.query(
        `INSERT INTO payment_details (payment_id, bill_id, proposal_item_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [payment.id, item.bill_id, item.id, item.owner_amount]
      );
    }

    // Update proposal status
    await client.query(
      `UPDATE proposals SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [proposal_id]
    );

    return payment;
  });

  res.status(201).json({
    message: 'Payment batch created',
    payment: result,
  });
}));

// POST /api/payments/:id/update-utr - Update UTR numbers
router.post('/:id/update-utr', authorize('accounts', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { details } = req.body; // [{detail_id, utr_number}]

  if (!details || !Array.isArray(details)) {
    return res.status(400).json({ error: 'details array is required' });
  }

  await transaction(async (client) => {
    for (const detail of details) {
      await client.query(
        `UPDATE payment_details 
         SET utr_number = $1, status = 'confirmed', updated_at = NOW()
         WHERE id = $2 AND payment_id = $3`,
        [detail.utr_number, detail.detail_id, id]
      );

      // Update bill paid amount
      const detailResult = await client.query(
        `SELECT bill_id, amount FROM payment_details WHERE id = $1`,
        [detail.detail_id]
      );

      if (detailResult.rows.length > 0 && detail.utr_number) {
        await client.query(
          `UPDATE inward_bills SET paid_amount = paid_amount + $1 WHERE id = $2`,
          [detailResult.rows[0].amount, detailResult.rows[0].bill_id]
        );

        // Update proposal item status
        await client.query(
          `UPDATE proposal_items SET status = 'paid' 
           WHERE id = (SELECT proposal_item_id FROM payment_details WHERE id = $1)`,
          [detail.detail_id]
        );
      }
    }

    // Check if all UTRs are entered
    const pendingResult = await client.query(
      `SELECT COUNT(*) FROM payment_details 
       WHERE payment_id = $1 AND (utr_number IS NULL OR utr_number = '')`,
      [id]
    );

    const newStatus = parseInt(pendingResult.rows[0].count) === 0 ? 'confirmed' : 'processed';
    await client.query(
      `UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, id]
    );
  });

  res.json({ message: 'UTR numbers updated' });
}));

// GET /api/payments/export-bank-file/:id - Export bank payment file
router.get('/export-bank-file/:id', authorize('accounts', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const paymentResult = await query(
    `SELECT p.*, ba.bank_type
     FROM payments p
     LEFT JOIN bank_accounts ba ON p.bank_account_id = ba.id
     WHERE p.id = $1`,
    [id]
  );

  if (paymentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const detailsResult = await query(
    `SELECT 
      pd.amount, v.name as beneficiary_name, v.account_number, v.ifsc_code,
      ib.bill_number
    FROM payment_details pd
    JOIN inward_bills ib ON pd.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    WHERE pd.payment_id = $1
    ORDER BY v.name`,
    [id]
  );

  // Return data for Excel generation (frontend will generate the file)
  res.json({
    payment: paymentResult.rows[0],
    details: detailsResult.rows,
    bankFormat: paymentResult.rows[0].bank_type || 'icici',
  });
}));

// GET /api/payments/summary - Payment summary stats
router.get('/summary/stats', asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT 
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date = CURRENT_DATE) as today_amount,
      (SELECT COUNT(*) FROM payments WHERE payment_date = CURRENT_DATE) as today_count,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date = CURRENT_DATE - 1) as yesterday_amount,
      (SELECT COUNT(*) FROM payments WHERE payment_date = CURRENT_DATE - 1) as yesterday_count,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date >= DATE_TRUNC('week', CURRENT_DATE)) as week_amount,
      (SELECT COALESCE(SUM(total_amount), 0) FROM payments WHERE payment_date >= DATE_TRUNC('month', CURRENT_DATE)) as month_amount,
      (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_count
  `);

  res.json(result.rows[0]);
}));

module.exports = router;
