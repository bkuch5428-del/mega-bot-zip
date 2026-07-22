'use strict';

/**
 * ProcessingQueue – a serial job queue that is crash-resistant.
 *
 * Key guarantees:
 * - A failed job never stops the queue from processing subsequent jobs.
 * - The process() loop itself is wrapped so a synchronous throw inside
 *   a job cannot kill the queue runner.
 * - Queue state is logged on every state change for observability.
 */
class ProcessingQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxRetries = 3;
        this.totalProcessed = 0;
        this.totalFailed = 0;
    }

    _log(level, msg) {
        const ts = new Date().toISOString();
        const line = `[${ts}] [QUEUE] [${level}] ${msg}`;
        if (level === 'ERROR') console.error(line);
        else console.log(line);
    }

    /**
     * Add a job (async function) to the queue.
     * Returns a promise that resolves/rejects when the job completes.
     */
    add(job) {
        return new Promise((resolve, reject) => {
            this.queue.push({ job, resolve, reject, retries: 0 });
            this._log('INFO', `Job enqueued. Queue length: ${this.queue.length}`);
            this._scheduleProcess();
        });
    }

    _scheduleProcess() {
        setImmediate(() => this._process());
    }

    async _process() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const item = this.queue.shift();
        const { job, resolve, reject, retries } = item;

        this._log('INFO', `Starting job (attempt ${retries + 1}/${this.maxRetries + 1}). Remaining in queue: ${this.queue.length}`);

        try {
            const result = await job();
            this.totalProcessed++;
            this._log('INFO', `Job succeeded. Total processed: ${this.totalProcessed}`);
            resolve(result);
        } catch (err) {
            if (retries < this.maxRetries) {
                const nextRetry = retries + 1;
                this._log('WARN', `Job failed (attempt ${nextRetry}/${this.maxRetries + 1}): ${err.message}. Re-queuing...`);
                // Put back at the front for retry.
                this.queue.unshift({ job, resolve, reject, retries: nextRetry });
            } else {
                this.totalFailed++;
                this._log('ERROR', `Job failed after ${this.maxRetries + 1} attempts. Total failed: ${this.totalFailed}. Error: ${err.message}`);
                if (err.stack) this._log('ERROR', err.stack);
                // Reject the caller's promise but do NOT propagate further.
                try { reject(err); } catch (_) {}
            }
        } finally {
            this.processing = false;
            // Always schedule the next job regardless of success/failure.
            this._scheduleProcess();
        }
    }

    getQueueLength() { return this.queue.length; }
    isProcessing()   { return this.processing; }

    clear() {
        const dropped = this.queue.length;
        this.queue = [];
        this.processing = false;
        if (dropped > 0) this._log('WARN', `Queue cleared. Dropped ${dropped} pending jobs.`);
    }

    status() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            totalProcessed: this.totalProcessed,
            totalFailed: this.totalFailed,
        };
    }
}

module.exports = new ProcessingQueue();
