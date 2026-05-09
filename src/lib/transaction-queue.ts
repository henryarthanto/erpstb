// =====================================================================
// TRANSACTION PROCESSING QUEUE
//
// Queue for PWA transactions to prevent DB flooding during peak load.
// Limits concurrent DB operations on STB (2GB RAM).
//
// Usage:
//   import { txProcessingQueue } from '@/lib/transaction-queue';
//   const result = await txProcessingQueue.enqueue(async () => { ... });
// =====================================================================

import { IS_STB } from './stb-config';

interface QueuedTx {
  id: string;
  execute: () => Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  enqueuedAt: number;
}

class TransactionProcessingQueue {
  private queue: QueuedTx[] = [];
  private running = 0;
  private readonly maxConcurrent = IS_STB ? 5 : 20;
  private readonly maxQueueSize = IS_STB ? 200 : 1000;
  private readonly timeoutMs = 30_000;

  async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Server sibuk. Coba lagi dalam beberapa detik.');
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.queue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new Error('Transaksi timeout menunggu diproses'));
        }
      }, this.timeoutMs);

      this.queue.push({
        id: Math.random().toString(36).slice(2),
        execute,
        resolve: (v) => { clearTimeout(timeoutId); resolve(v); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
        enqueuedAt: Date.now(),
      });

      this.processNext();
    });
  }

  private async processNext() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.running++;

    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.running--;
      this.processNext();
    }
  }

  getStats() {
    return { queued: this.queue.length, running: this.running, maxConcurrent: this.maxConcurrent };
  }
}

export const txProcessingQueue = new TransactionProcessingQueue();
