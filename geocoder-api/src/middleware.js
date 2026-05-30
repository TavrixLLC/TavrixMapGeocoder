'use strict';

const { randomUUID } = require('crypto');
const { ApiError } = require('./errors');

/**
 * Middleware: assigns or propagates X-Request-ID
 */
function requestIdMiddleware() {
  return (req, res, next) => {
    const id = req.get('x-request-id') || randomUUID();
    req.requestId = id;
    res.set('X-Request-ID', id);
    next();
  };
}

/**
 * Middleware: structured JSON access logging
 */
function accessLogMiddleware(config = {}) {
  return (req, res, next) => {
    const start = Date.now();
    const onFinish = () => {
      res.removeListener('finish', onFinish);
      const entry = {
        ts: new Date().toISOString(),
        level: 'info',
        service: 'geocoder-api',
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        latency_ms: Date.now() - start
      };
      if (config.logSearchText && req.query && req.query.text) {
        entry.query_text = req.query.text;
      }
      console.log(JSON.stringify(entry));
    };
    res.on('finish', onFinish);
    next();
  };
}

/**
 * Middleware: requires valid internal token via
 *   x-internal-token header  OR  Authorization: Bearer <token>
 */
function requireInternalToken(config) {
  return (req, res, next) => {
    const expected = config.internalToken;
    if (!expected) {
      next(new ApiError('internal_token_not_configured', 'INTERNAL_TOKEN is not configured', 503));
      return;
    }

    const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const header = req.get('x-internal-token');
    if (bearer === expected || header === expected) {
      next();
      return;
    }

    next(new ApiError('unauthorized', 'Internal token is required', 401));
  };
}

/**
 * Validates that response_mode=debug has a valid internal token.
 * For standard/full, passes through.
 */
function gateDebugResponseMode(config) {
  return (req, _res, next) => {
    if (req.query.response_mode !== 'debug') {
      next();
      return;
    }
    const expected = config.internalToken;
    if (!expected) {
      next(new ApiError('forbidden', 'Debug response mode requires internal token', 403));
      return;
    }
    const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const header = req.get('x-internal-token');
    if (bearer === expected || header === expected) {
      next();
      return;
    }
    next(new ApiError('forbidden', 'Debug response mode requires internal token', 403));
  };
}

module.exports = {
  requestIdMiddleware,
  accessLogMiddleware,
  requireInternalToken,
  gateDebugResponseMode
};
