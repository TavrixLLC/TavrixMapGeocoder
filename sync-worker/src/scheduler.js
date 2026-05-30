'use strict';

const cron = require('node-cron');

class Scheduler {
  constructor(syncService, metrics, logger) {
    this.syncService = syncService;
    this.metrics = metrics;
    this.log = logger;
    this.tasks = [];
    this.running = new Set();
  }

  start(sources) {
    for (const source of sources.filter(src => src.enabled !== false)) {
      if (!source.schedule) {
        this.log.warn('Source has no schedule; skipping scheduled registration', { source: source.name });
        this.metrics.scheduleStatus.labels(source.name).set(0);
        continue;
      }

      if (!cron.validate(source.schedule)) {
        throw new Error(`Invalid cron schedule for ${source.name}: ${source.schedule}`);
      }

      const task = cron.schedule(source.schedule, async () => {
        if (this.running.has(source.name)) {
          this.log.warn('Source sync already running; skipping overlapping schedule', { source: source.name });
          return;
        }

        this.running.add(source.name);
        try {
          await this.syncService.syncSource(source.name, { mode: 'scheduled' });
        } finally {
          this.running.delete(source.name);
        }
      });

      this.tasks.push(task);
      this.metrics.scheduleStatus.labels(source.name).set(1);
      this.log.info('Scheduled source sync', { source: source.name, schedule: source.schedule });
    }
  }

  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
  }
}

module.exports = Scheduler;
