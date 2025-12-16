// 404 Not Found handler
const notFound = (req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

// Global error handler
const errorHandler = (err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  // PostgreSQL errors
  if (err.code) {
    switch (err.code) {
      case '23505': // Unique violation
        return res.status(409).json({
          error: 'Duplicate entry',
          message: 'A record with this value already exists',
          detail: err.detail,
        });
      case '23503': // Foreign key violation
        return res.status(400).json({
          error: 'Invalid reference',
          message: 'Referenced record does not exist',
          detail: err.detail,
        });
      case '23502': // Not null violation
        return res.status(400).json({
          error: 'Missing required field',
          message: 'A required field was not provided',
          detail: err.detail,
        });
      case '22P02': // Invalid text representation
        return res.status(400).json({
          error: 'Invalid input',
          message: 'Invalid data format',
        });
    }
  }

  // Validation errors from express-validator
  if (err.array && typeof err.array === 'function') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.array(),
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid token',
      message: 'The provided authentication token is invalid',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired',
      message: 'Your session has expired. Please login again.',
    });
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'File too large',
      message: 'The uploaded file exceeds the maximum allowed size',
    });
  }

  // Default error response
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: err.name || 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' 
      ? err.message 
      : 'An unexpected error occurred',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// Async handler wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  notFound,
  errorHandler,
  asyncHandler,
};
