/** Shared search snippet formatting for session and history search. */

export function snippetFromContent(content: string, query: string, width = 80): string {
    const lower = content.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) return content.slice(0, width);
    const start = Math.max(0, idx - 24);
    const end = Math.min(content.length, idx + query.length + 24);
    let out = content.slice(start, end);
    if (start > 0) out = `…${out}`;
    if (end < content.length) out = `${out}…`;
    const idxInOut = out.toLowerCase().indexOf(q);
    if (idxInOut >= 0) {
        out = `${out.slice(0, idxInOut)}[${query}]${out.slice(idxInOut + query.length)}`;
    }
    return out;
}
