'use strict';

const { ApiError, errorBody } = require('./errors');

class PeliasClient {
  constructor(baseUrl, fetchImpl = global.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async get(path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(key, value);
    }

    const response = await this.fetch(url);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new ApiError('upstream_error', 'Pelias API request failed', response.status, {
        path,
        upstream: payload
      });
    }

    return payload;
  }

  async proxy(req, res) {
    try {
      const payload = await this.get(req.path, req.query);
      res.json(payload);
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.status).json(errorBody(err.code, err.message, err.details));
        return;
      }
      throw err;
    }
  }
}

module.exports = PeliasClient;
