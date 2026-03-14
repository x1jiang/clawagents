/**
 * Per-key serialization queue.
 *
 * Ensures that async work for the same key (e.g. a conversation session)
 * is executed sequentially, while different keys run in parallel.
 * Inspired by OpenClaw's KeyedAsyncQueue.
 */

type Task = () => Promise<void>;

export class KeyedAsyncQueue {
    private queues = new Map<string, Task[]>();
    private running = new Set<string>();

    async enqueue(key: string, task: Task): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const wrapped: Task = async () => {
                try {
                    await task();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            };

            let q = this.queues.get(key);
            if (!q) {
                q = [];
                this.queues.set(key, q);
            }
            q.push(wrapped);

            if (!this.running.has(key)) {
                this.drain(key);
            }
        });
    }

    private async drain(key: string) {
        this.running.add(key);
        const q = this.queues.get(key)!;
        while (q.length > 0) {
            const task = q.shift()!;
            try {
                await task();
            } catch {
                // errors are forwarded to the promise returned by enqueue
            }
        }
        this.running.delete(key);
        this.queues.delete(key);
    }

    get activeKeys(): number {
        return this.running.size;
    }
}
