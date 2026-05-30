'use strict';

class ApiError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function errorBody(code, message, details = {}, requestId) {
  return {
    error: {
      code,
      message,
      request_id: requestId || 'unknown',
      details
    }
  };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorMiddleware(err, req, res, _next) {
  const requestId = req.requestId || req.get('x-request-id') || undefined;

  if (err instanceof ApiError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details, requestId));
    return;
  }

  // Elasticsearch ConnectionError → 503
  if (err && (err.name === 'ConnectionError' || (err.message && err.message.includes('ECONNREFUSED')))) {
    res.status(503).json(errorBody('service_unavailable', 'Elasticsearch is unavailable', {
      reason: err.message
    }, requestId));
    return;
  }

  // Elasticsearch TimeoutError → 504
  if (err && (err.name === 'TimeoutError' || (err.message && err.message.includes('Request timed out')))) {
    res.status(504).json(errorBody('gateway_timeout', 'Elasticsearch request timed out', {
      reason: err.message
    }, requestId));
    return;
  }

  // Elasticsearch ResponseError → 502
  if (err && err.name === 'ResponseError') {
    res.status(err.statusCode || 502).json(errorBody('elasticsearch_error', 'Elasticsearch request failed', {
      status: err.statusCode,
      reason: err.message
    }, requestId));
    return;
  }

  res.status(500).json(errorBody('internal_error', 'Internal server error', {
    message: err && err.message ? err.message : String(err)
  }, requestId));
}

module.exports = {
  ApiError,
  asyncHandler,
  errorBody,
  errorMiddleware
};
