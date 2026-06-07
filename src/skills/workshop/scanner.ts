/** Lightweight proposal scanner before apply. */

const MAX_SKILL_BYTES = 40_000;
const MAX_DESCRIPTION_BYTES = 160;
const MAX_SUPPORT_FILES = 64;
const MAX_SUPPORT_FILE_BYTES = 256 * 1024;

const SUSPICIOUS = /(rm\s+-rf|curl\s+.*\|\s*(ba)?sh|eval\s*\(|exec\s*\(|__import__|subprocess\.|os\.system)/i;

const STANDARD_FOLDERS = new Set(["assets", "examples", "references", "scripts", "templates"]);

export function scanProposalContent(
    name: string,
    description: string,
    body: string,
    supportFiles: Array<[string, string]>,
): string[] {
    const findings: string[] = [];
    if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
        findings.push("skill name must be lowercase alphanumeric with hyphens/underscores");
    }
    if (Buffer.byteLength(description, "utf-8") > MAX_DESCRIPTION_BYTES) {
        findings.push(`description exceeds ${MAX_DESCRIPTION_BYTES} bytes`);
    }
    if (Buffer.byteLength(body, "utf-8") > MAX_SKILL_BYTES) {
        findings.push(`proposal body exceeds ${MAX_SKILL_BYTES} bytes`);
    }
    if (supportFiles.length > MAX_SUPPORT_FILES) {
        findings.push(`too many support files (max ${MAX_SUPPORT_FILES})`);
    }
    for (const [path, content] of supportFiles) {
        if (SUSPICIOUS.test(content)) {
            findings.push(`suspicious pattern in support file ${path}`);
        }
        if (Buffer.byteLength(content, "utf-8") > MAX_SUPPORT_FILE_BYTES) {
            findings.push(`support file too large: ${path}`);
        }
        const parts = path.split(/[/\\]/);
        if (!STANDARD_FOLDERS.has(parts[0]!)) {
            findings.push(`support file must live under standard folders: ${path}`);
        }
        if (parts.includes("..") || path.startsWith("/")) {
            findings.push(`invalid support path: ${path}`);
        }
    }
    if (SUSPICIOUS.test(body)) {
        findings.push("suspicious pattern in proposal body");
    }
    return findings;
}
