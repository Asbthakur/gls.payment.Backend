const { body, param, query: queryValidator, validationResult } = require('express-validator');

// Process validation results
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
        value: err.value,
      })),
    });
  }
  next();
};

// Common validators
const validators = {
  // UUID validator
  uuid: (field, location = 'param') => {
    const validator = location === 'param' ? param(field) : body(field);
    return validator
      .isUUID(4)
      .withMessage(`${field} must be a valid UUID`);
  },

  // Required string
  requiredString: (field, minLength = 1, maxLength = 255) => {
    return body(field)
      .trim()
      .notEmpty().withMessage(`${field} is required`)
      .isLength({ min: minLength, max: maxLength })
      .withMessage(`${field} must be between ${minLength} and ${maxLength} characters`);
  },

  // Optional string
  optionalString: (field, maxLength = 255) => {
    return body(field)
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: maxLength })
      .withMessage(`${field} must not exceed ${maxLength} characters`);
  },

  // Email
  email: (field, required = true) => {
    let validator = body(field);
    if (!required) {
      validator = validator.optional({ nullable: true, checkFalsy: true });
    }
    return validator
      .trim()
      .isEmail().withMessage(`${field} must be a valid email address`)
      .normalizeEmail();
  },

  // Phone
  phone: (field) => {
    return body(field)
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .matches(/^[0-9+\-\s()]{8,20}$/)
      .withMessage(`${field} must be a valid phone number`);
  },

  // Amount (decimal)
  amount: (field, required = true) => {
    let validator = body(field);
    if (!required) {
      validator = validator.optional({ nullable: true });
    } else {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    }
    return validator
      .isFloat({ min: 0 }).withMessage(`${field} must be a positive number`)
      .toFloat();
  },

  // Integer
  integer: (field, min = 0, max = null, required = true) => {
    let validator = body(field);
    if (!required) {
      validator = validator.optional({ nullable: true });
    } else {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    }
    const options = { min };
    if (max !== null) options.max = max;
    return validator
      .isInt(options).withMessage(`${field} must be an integer ${max ? `between ${min} and ${max}` : `greater than ${min}`}`)
      .toInt();
  },

  // Date
  date: (field, required = true) => {
    let validator = body(field);
    if (!required) {
      validator = validator.optional({ nullable: true, checkFalsy: true });
    } else {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    }
    return validator
      .isISO8601().withMessage(`${field} must be a valid date (YYYY-MM-DD)`);
  },

  // GSTIN
  gstin: (field) => {
    return body(field)
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
      .withMessage(`${field} must be a valid GSTIN`);
  },

  // IFSC Code
  ifsc: (field) => {
    return body(field)
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .matches(/^[A-Z]{4}0[A-Z0-9]{6}$/)
      .withMessage(`${field} must be a valid IFSC code`);
  },

  // Pagination
  pagination: () => [
    queryValidator('page')
      .optional()
      .isInt({ min: 1 }).withMessage('Page must be a positive integer')
      .toInt(),
    queryValidator('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
      .toInt(),
    queryValidator('sortBy')
      .optional()
      .trim()
      .isAlphanumeric('en-US', { ignore: '_' }).withMessage('Invalid sort field'),
    queryValidator('sortOrder')
      .optional()
      .isIn(['asc', 'desc', 'ASC', 'DESC']).withMessage('Sort order must be asc or desc'),
  ],

  // Search
  search: () => {
    return queryValidator('search')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Search term too long');
  },
};

// Validation rules for different entities
const validationRules = {
  // Inward Bill
  createInwardBill: [
    validators.uuid('vendor_id', 'body'),
    validators.requiredString('bill_number', 1, 50),
    validators.date('invoice_date'),
    validators.date('receiving_date'),
    validators.amount('amount'),
    validators.integer('credit_days', 0, 365),
    validators.requiredString('checked_by', 1, 100),
    validators.optionalString('remarks', 500),
    validate,
  ],

  // Outward Bill
  createOutwardBill: [
    validators.uuid('customer_id', 'body'),
    validators.requiredString('invoice_number', 1, 50),
    validators.date('invoice_date'),
    validators.amount('amount'),
    validators.integer('credit_days', 0, 365),
    validators.requiredString('dispatched_by', 1, 100),
    validators.optionalString('delivery_mode', 50),
    validators.optionalString('delivery_person', 100),
    validators.optionalString('courier_name', 100),
    validators.optionalString('tracking_number', 100),
    validators.optionalString('remarks', 500),
    validate,
  ],

  // Proposal
  createProposal: [
    validators.date('payment_date'),
    validators.optionalString('remarks', 500),
    body('items')
      .isArray({ min: 1 }).withMessage('At least one bill must be selected'),
    body('items.*.bill_id')
      .isUUID(4).withMessage('Invalid bill ID'),
    body('items.*.proposed_amount')
      .isFloat({ min: 0 }).withMessage('Proposed amount must be positive'),
    validate,
  ],

  // Vendor
  createVendor: [
    validators.requiredString('code', 1, 20),
    validators.requiredString('name', 1, 150),
    validators.phone('phone'),
    validators.phone('mobile'),
    validators.phone('whatsapp'),
    validators.email('email', false),
    validators.gstin('gstin'),
    validators.optionalString('pan', 10),
    validators.optionalString('address', 500),
    validators.optionalString('city', 100),
    validators.optionalString('state', 50),
    validators.optionalString('pincode', 10),
    validators.optionalString('bank_name', 100),
    validators.optionalString('account_number', 30),
    validators.ifsc('ifsc_code'),
    validators.integer('default_credit_days', 0, 365, false),
    validate,
  ],

  // Customer
  createCustomer: [
    validators.requiredString('code', 1, 20),
    validators.requiredString('name', 1, 150),
    validators.optionalString('contact_person', 100),
    validators.phone('phone'),
    validators.phone('mobile'),
    validators.phone('whatsapp'),
    validators.email('email', false),
    validators.gstin('gstin'),
    validators.optionalString('address', 500),
    validators.optionalString('city', 100),
    validators.optionalString('state', 50),
    validators.optionalString('pincode', 10),
    validators.integer('default_credit_days', 0, 365, false),
    validators.amount('credit_limit', false),
    validate,
  ],

  // UUID param
  uuidParam: [
    validators.uuid('id'),
    validate,
  ],
};

module.exports = {
  validate,
  validators,
  validationRules,
};
