"use strict";

class RequestQueue {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.queue = [];
    this.active = 0;
    this.maxActive = 0;
    this.started = 0;
    this.completed = 0;
    this.failed = 0;
    this.staleDropped = 0;
    this.rejected = 0;
    this.maxDepth = 0;
  }

  enqueue(metadata, task) {
    if (this.queue.length >= this.config.maxQueueSize) {
      this.rejected++;
      const error = new Error("bridge request queue is full");
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const item = {
        metadata,
        task,
        resolve,
        reject,
        queuedAt: Date.now()
      };

      this.queue.push(item);
      this.maxDepth = Math.max(this.maxDepth, this.queue.length);
      this.logger("info", "queue_enqueue", {
        eventId: metadata.eventId,
        channel: metadata.channel,
        bot: metadata.bot,
        player: metadata.player,
        queueDepth: this.queue.length,
        active: this.active
      });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.config.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      const ageMs = Date.now() - item.queuedAt;
      if (ageMs > this.config.maxQueueAgeMs) {
        this.staleDropped++;
        const error = new Error("bridge request expired while queued");
        error.code = "STALE_REQUEST";
        item.reject(error);
        this.logger("warn", "queue_stale_drop", {
          eventId: item.metadata.eventId,
          ageMs,
          queueDepth: this.queue.length
        });
        continue;
      }

      this.run(item, ageMs);
    }
  }

  async run(item, queuedMs) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started++;
    const start = Date.now();

    try {
      const result = await item.task({ queuedMs });
      this.completed++;
      item.resolve(result);
    } catch (error) {
      this.failed++;
      item.reject(error);
    } finally {
      this.active--;
      this.logger("info", "queue_complete", {
        eventId: item.metadata.eventId,
        queuedMs,
        latencyMs: Date.now() - start,
        active: this.active,
        queueDepth: this.queue.length
      });
      setImmediate(() => this.drain());
    }
  }

  dropStale() {
    const now = Date.now();
    const kept = [];
    for (const item of this.queue) {
      const ageMs = now - item.queuedAt;
      if (ageMs > this.config.maxQueueAgeMs) {
        this.staleDropped++;
        const error = new Error("bridge request expired while queued");
        error.code = "STALE_REQUEST";
        item.reject(error);
      } else {
        kept.push(item);
      }
    }
    this.queue = kept;
  }

  stats() {
    this.dropStale();
    return {
      active: this.active,
      maxActive: this.maxActive,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueueSize: this.config.maxQueueSize,
      maxDepth: this.maxDepth,
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      staleDropped: this.staleDropped,
      rejected: this.rejected
    };
  }
}

module.exports = {
  RequestQueue
};
