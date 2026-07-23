/**
 * Incrementally retains the beginning and end of a text stream without
 * buffering the discarded middle in memory.
 */
export class BoundedTextAccumulator {
    readonly maxChars: number;
    totalChars = 0;
    private readonly headLimit: number;
    private readonly tailLimit: number;
    private head = "";
    private tail = "";

    constructor(maxChars: number) {
        if (!Number.isFinite(maxChars) || maxChars < 2) {
            throw new Error("maxChars must be at least 2");
        }
        this.maxChars = Math.floor(maxChars);
        this.headLimit = Math.ceil(this.maxChars / 2);
        this.tailLimit = this.maxChars - this.headLimit;
    }

    append(chunk: string): void {
        if (!chunk) return;
        this.totalChars += chunk.length;

        if (this.head.length < this.headLimit) {
            const needed = this.headLimit - this.head.length;
            this.head += chunk.slice(0, needed);
            chunk = chunk.slice(needed);
        }

        if (chunk && this.tailLimit > 0) {
            this.tail = (this.tail + chunk).slice(-this.tailLimit);
        }
    }

    get truncatedChars(): number {
        return Math.max(0, this.totalChars - this.maxChars);
    }

    toString(): string {
        if (this.truncatedChars === 0) return this.head + this.tail;
        return `${this.head}\n\n... [truncated ${this.truncatedChars} chars] ...\n\n${this.tail}`;
    }
}
