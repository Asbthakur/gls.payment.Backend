const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');
const { validationRules, validators } = require('../middleware/validation.middleware');

router.use(authenticate);

// GET /api/proposals - List proposals
router.get('/', ...validators.pagination(), asyncHandler(async (req, res) => {
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
    whereClause += ` AND p.proposal_date >= $${paramIndex}`;
    params.push(dateFrom);
    paramIndex++;
  }

  if (dateTo) {
    whereClause += ` AND p.proposal_date <= $${paramIndex}`;
    params.push(dateTo);
    paramIndex++;
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM proposals p ${whereClause}`,
    params
  );

  const proposalsResult = await query(
    `SELECT 
      p.*, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM proposal_items WHERE proposal_id = p.id) as item_count
    FROM proposals p
    LEFT JOIN users u ON p.created_by = u.id
    ${whereClause}
    ORDER BY p.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  res.json({
    data: proposalsResult.rows,
    pagination: {
      page, limit,
      total: parseInt(countResult.rows[0].count),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    },
  });
}));

// GET /api/proposals/available-bills - Bills available for proposal
router.get('/available-bills', asyncHandler(async (req, res) => {
  const vendorId = req.query.vendor_id;
  const filter = req.query.filter; // 'overdue', 'due_today', 'due_week', 'carry_forward'

  let whereClause = `
    WHERE ib.status = 'active' 
    AND ib.payment_status != 'paid'
    AND NOT EXISTS (
      SELECT 1 FROM proposal_items pi 
      JOIN proposals p ON pi.proposal_id = p.id
      WHERE pi.bill_id = ib.id 
      AND p.status NOT IN ('rejected', 'completed')
      AND pi.status NOT IN ('owner_rejected', 'paid')
    )
  `;
  const params = [];
  let paramIndex = 1;

  if (vendorId) {
    whereClause += ` AND ib.vendor_id = $${paramIndex}`;
    params.push(vendorId);
    paramIndex++;
  }

  if (filter === 'overdue') {
    whereClause += ` AND ib.due_date < CURRENT_DATE`;
  } else if (filter === 'due_today') {
    whereClause += ` AND ib.due_date = CURRENT_DATE`;
  } else if (filter === 'due_week') {
    whereClause += ` AND ib.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`;
  } else if (filter === 'carry_forward') {
    whereClause = `
      WHERE ib.status = 'active' 
      AND ib.payment_status != 'paid'
      AND EXISTS (
        SELECT 1 FROM proposal_items pi 
        WHERE pi.bill_id = ib.id AND pi.status = 'carry_forward'
      )
    `;
  }

  const result = await query(
    `SELECT 
      ib.id, ib.bill_number, ib.invoice_date, ib.amount, ib.paid_amount,
      (ib.amount - ib.paid_amount) as outstanding, ib.due_date, ib.credit_days,
      v.id as vendor_id, v.code as vendor_code, v.name as vendor_name,
      u.full_name as entered_by,
      CASE 
        WHEN ib.due_date < CURRENT_DATE THEN CURRENT_DATE - ib.due_date 
        ELSE -(ib.due_date - CURRENT_DATE)
      END as age_days,
      (SELECT COUNT(*) FROM proposal_items pi WHERE pi.bill_id = ib.id AND pi.status = 'carry_forward') as carry_forward_count
    FROM inward_bills ib
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    ${whereClause}
    ORDER BY ib.due_date ASC`,
    params
  );

  // Summary
  const summary = await query(`
    SELECT 
      COUNT(CASE WHEN due_date < CURRENT_DATE THEN 1 END) as overdue_count,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN amount - paid_amount END), 0) as overdue_amount,
      COUNT(CASE WHEN due_date = CURRENT_DATE THEN 1 END) as due_today_count,
      COALESCE(SUM(CASE WHEN due_date = CURRENT_DATE THEN amount - paid_amount END), 0) as due_today_amount,
      COUNT(CASE WHEN due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7 THEN 1 END) as due_week_count,
      COALESCE(SUM(CASE WHEN due_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7 THEN amount - paid_amount END), 0) as due_week_amount
    FROM inward_bills
    WHERE status = 'active' AND payment_status != 'paid'
  `);

  res.json({
    data: result.rows,
    summary: summary.rows[0],
  });
}));

// GET /api/proposals/:id - Get proposal with items
router.get('/:id', validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const proposalResult = await query(
    `SELECT p.*, u.full_name as created_by_name
     FROM proposals p
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.id = $1`,
    [id]
  );

  if (proposalResult.rows.length === 0) {
    return res.status(404).json({ error: 'Proposal not found' });
  }

  const itemsResult = await query(
    `SELECT 
      pi.*, ib.bill_number, ib.invoice_date, ib.amount as bill_amount,
      ib.paid_amount, ib.due_date,
      v.code as vendor_code, v.name as vendor_name,
      u_entry.full_name as entered_by,
      u_accts.full_name as accounts_by,
      u_owner.full_name as owner_by
    FROM proposal_items pi
    JOIN inward_bills ib ON pi.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u_entry ON ib.created_by = u_entry.id
    LEFT JOIN users u_accts ON pi.accounts_by = u_accts.id
    LEFT JOIN users u_owner ON pi.owner_by = u_owner.id
    WHERE pi.proposal_id = $1
    ORDER BY v.name, ib.due_date`,
    [id]
  );

  res.json({
    proposal: proposalResult.rows[0],
    items: itemsResult.rows,
  });
}));

// POST /api/proposals - Create proposal (Purchase)
router.post('/', authorize('purchase', 'owner'), validationRules.createProposal, asyncHandler(async (req, res) => {
  const { payment_date, remarks, items } = req.body;

  const result = await transaction(async (client) => {
    // Generate proposal number
    const numberResult = await client.query('SELECT generate_proposal_number() as proposal_number');
    const proposalNumber = numberResult.rows[0].proposal_number;

    // Calculate total
    const totalAmount = items.reduce((sum, item) => sum + parseFloat(item.proposed_amount), 0);

    // Create proposal
    const proposalResult = await client.query(
      `INSERT INTO proposals (proposal_number, proposal_date, payment_date, total_amount, remarks, created_by)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5) RETURNING *`,
      [proposalNumber, payment_date, totalAmount, remarks, req.user.id]
    );
    const proposal = proposalResult.rows[0];

    // Create proposal items
    for (const item of items) {
      await client.query(
        `INSERT INTO proposal_items (proposal_id, bill_id, proposed_amount, urgency_remarks)
         VALUES ($1, $2, $3, $4)`,
        [proposal.id, item.bill_id, item.proposed_amount, item.remarks || null]
      );
    }

    return proposal;
  });

  res.status(201).json({
    message: 'Proposal created successfully',
    proposal: result,
  });
}));

// POST /api/proposals/:id/submit - Submit proposal for review
router.post('/:id/submit', authorize('purchase', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await query(
    `UPDATE proposals 
     SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'draft' AND created_by = $2
     RETURNING *`,
    [id, req.user.id]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Cannot submit this proposal' });
  }

  res.json({ message: 'Proposal submitted', proposal: result.rows[0] });
}));

// POST /api/proposals/:id/accounts-action - Accounts validation
router.post('/:id/accounts-action', authorize('accounts', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { items } = req.body; // [{item_id, action, amount, reason}]

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Items array is required' });
  }

  await transaction(async (client) => {
    for (const item of items) {
      const { item_id, action, amount, reason } = item;

      if (!['approve', 'hold', 'reject'].includes(action)) {
        throw new Error(`Invalid action: ${action}`);
      }

      const accountsStatus = action === 'approve' ? 'approved' : action === 'hold' ? 'held' : 'pending';
      const itemStatus = action === 'approve' ? 'accounts_approved' : action === 'hold' ? 'accounts_held' : 'proposed';

      await client.query(
        `UPDATE proposal_items 
         SET accounts_status = $1, accounts_amount = $2, accounts_reason = $3,
             accounts_at = NOW(), accounts_by = $4, status = $5
         WHERE id = $6`,
        [accountsStatus, amount, reason, req.user.id, itemStatus, item_id]
      );
    }

    // Update proposal status
    await client.query(
      `UPDATE proposals SET status = 'under_review', updated_at = NOW() WHERE id = $1`,
      [id]
    );
  });

  res.json({ message: 'Accounts validation updated' });
}));

// POST /api/proposals/:id/owner-action - Owner approval
router.post('/:id/owner-action', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { items } = req.body; // [{item_id, action, amount, reason}]

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Items array is required' });
  }

  await transaction(async (client) => {
    let hasApproved = false;
    let hasDeferred = false;

    for (const item of items) {
      const { item_id, action, amount, reason } = item;

      if (!['approve', 'defer', 'reject'].includes(action)) {
        throw new Error(`Invalid action: ${action}`);
      }

      const ownerStatus = action === 'approve' ? 'approved' : action === 'defer' ? 'deferred' : 'rejected';
      const itemStatus = action === 'approve' ? 'owner_approved' : 
                        action === 'defer' ? 'owner_deferred' : 'owner_rejected';

      if (action === 'approve') hasApproved = true;
      if (action === 'defer') hasDeferred = true;

      await client.query(
        `UPDATE proposal_items 
         SET owner_status = $1, owner_amount = $2, owner_reason = $3,
             owner_at = NOW(), owner_by = $4, status = $5
         WHERE id = $6`,
        [ownerStatus, amount, reason, req.user.id, itemStatus, item_id]
      );

      // If deferred, mark for carry forward
      if (action === 'defer') {
        await client.query(
          `UPDATE proposal_items SET status = 'carry_forward' WHERE id = $1`,
          [item_id]
        );
      }
    }

    // Update proposal status
    const newStatus = hasApproved && !hasDeferred ? 'approved' : 
                     hasApproved && hasDeferred ? 'partial_approved' : 'rejected';
    
    await client.query(
      `UPDATE proposals SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, id]
    );
  });

  res.json({ message: 'Owner approval processed' });
}));

// GET /api/proposals/:id/for-accounts - Get proposal for accounts validation
router.get('/:id/for-accounts', authorize('accounts', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const proposalResult = await query(
    `SELECT p.*, u.full_name as created_by_name
     FROM proposals p
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.id = $1 AND p.status IN ('submitted', 'under_review')`,
    [id]
  );

  if (proposalResult.rows.length === 0) {
    return res.status(404).json({ error: 'Proposal not found or not ready for validation' });
  }

  const itemsResult = await query(
    `SELECT 
      pi.id, pi.proposed_amount, pi.urgency_remarks, pi.accounts_status, pi.accounts_amount,
      ib.id as bill_id, ib.bill_number, ib.invoice_date, ib.amount as bill_amount,
      ib.due_date, (ib.amount - ib.paid_amount) as outstanding,
      v.code as vendor_code, v.name as vendor_name,
      u.full_name as entered_by,
      CURRENT_DATE - ib.due_date as age_days
    FROM proposal_items pi
    JOIN inward_bills ib ON pi.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u ON ib.created_by = u.id
    WHERE pi.proposal_id = $1
    ORDER BY ib.due_date ASC`,
    [id]
  );

  res.json({
    proposal: proposalResult.rows[0],
    items: itemsResult.rows,
  });
}));

// GET /api/proposals/:id/for-owner - Get proposal for owner approval
router.get('/:id/for-owner', authorize('owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const proposalResult = await query(
    `SELECT p.*, u.full_name as created_by_name
     FROM proposals p
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.id = $1 AND p.status IN ('under_review', 'approved', 'partial_approved')`,
    [id]
  );

  if (proposalResult.rows.length === 0) {
    return res.status(404).json({ error: 'Proposal not found or not ready for approval' });
  }

  const itemsResult = await query(
    `SELECT 
      pi.*, ib.bill_number, ib.invoice_date, ib.due_date,
      (ib.amount - ib.paid_amount) as outstanding,
      v.code as vendor_code, v.name as vendor_name,
      u_entry.full_name as godown_by,
      u_accts.full_name as accounts_by
    FROM proposal_items pi
    JOIN inward_bills ib ON pi.bill_id = ib.id
    JOIN vendors v ON ib.vendor_id = v.id
    LEFT JOIN users u_entry ON ib.created_by = u_entry.id
    LEFT JOIN users u_accts ON pi.accounts_by = u_accts.id
    WHERE pi.proposal_id = $1 AND pi.accounts_status = 'approved'
    ORDER BY ib.due_date ASC`,
    [id]
  );

  res.json({
    proposal: proposalResult.rows[0],
    items: itemsResult.rows,
  });
}));

// DELETE /api/proposals/:id - Delete draft proposal
router.delete('/:id', authorize('purchase', 'owner'), validationRules.uuidParam, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await transaction(async (client) => {
    // Delete items first
    await client.query('DELETE FROM proposal_items WHERE proposal_id = $1', [id]);
    
    // Delete proposal (only if draft and owned by user)
    const deleteResult = await client.query(
      `DELETE FROM proposals WHERE id = $1 AND status = 'draft' 
       AND (created_by = $2 OR $3 = 'owner') RETURNING id`,
      [id, req.user.id, req.user.role]
    );

    return deleteResult.rows[0];
  });

  if (!result) {
    return res.status(400).json({ error: 'Cannot delete this proposal' });
  }

  res.json({ message: 'Proposal deleted' });
}));

module.exports = router;
