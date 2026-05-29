'use strict';

class ErrorHandler {
  constructor(pool, logger) {
    this.pool = pool;
    this.log = logger;
  }

  classifyError(error) {
    if (!error) return 'UNKNOWN';

    const status = error.statusCode || error.status;
    const code = error.code;

    // Transient errors — retryable
    if (status === 429) return 'TRANSIENT';
    if (status === 503) return 'TRANSIENT';
    if (status === 502) return 'TRANSIENT';
    if (status === 504) return 'TRANSIENT';
    if (code === 'ECONNREFUSED') return 'TRANSIENT';
    if (code === 'ETIMEDOUT') return 'TRANSIENT';
    if (code === 'ECONNRESET') return 'TRANSIENT';
    if (code === 'EPIPE') return 'TRANSIENT';
    if (code === 'EAI_AGAIN') return 'TRANSIENT';

    // Permanent errors — do not retry
    if (status === 400) return 'PERMANENT';
    if (status === 404) return 'PERMANENT';
    if (status === 409) return 'PERMANENT';

    return 'UNKNOWN';
  }

  async sendToDlq(event, error, errorType) {
    const errorMessage = typeof error === 'string'
      ? error
      : (error?.message || JSON.stringify(error));

    try {
      await this.pool.query(`
        INSERT INTO pelias_dlq
          (original_event_id, table_name, action, record_id,
           error_type, error_message, trigger_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        event.id,
        event.table_name,
        event.action,
        event.record_id,
        errorType || 'UNKNOWN',
        errorMessage,
        event.trigger_version
      ]);

      this.log.warn('Event sent to DLQ', {
        eventId: event.id,
        table: event.table_name,
        recordId: event.record_id,
        errorType,
        error: errorMessage
      });
    } catch (dlqErr) {
      this.log.error('Failed to write to DLQ', {
        eventId: event.id,
        dlqError: dlqErr.message,
        originalError: errorMessage
      });
    }
  }

  async handleBulkFailures(failedItems, eventReader, maxRetries) {
    const retryIds = [];
    const dlqEvents = [];

    for (const { event, error } of failedItems) {
      const errorType = this.classifyError(error);

      if (errorType === 'PERMANENT') {
        await this.sendToDlq(event, error, errorType);
        dlqEvents.push(event.id);
      } else if (event.retry_count >= (maxRetries - 1)) {
        await this.sendToDlq(event, error, 'EXHAUSTED');
        dlqEvents.push(event.id);
      } else {
        retryIds.push(event.id);
      }
    }

    if (retryIds.length > 0) {
      await eventReader.markFailed(retryIds, 'Transient ES error — will retry');
    }
    if (dlqEvents.length > 0) {
      await eventReader.markProcessed(dlqEvents);
    }

    return { retriedCount: retryIds.length, dlqCount: dlqEvents.length };
  }
}

module.exports = ErrorHandler;
