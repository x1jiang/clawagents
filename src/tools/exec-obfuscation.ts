/**
 * Command obfuscation detector.
 *
 * Ports the spirit of `openclaw-main/src/infra/exec-obfuscation-detect.ts`.
 * Catches commands that try to bypass an allowlist by encoding/decoding
 * into a shell exec — e.g. `base64 -d | sh`, `curl … | sh`, process
 * substitution from network sources, hex/octal escape strings into
 * `eval`.
 *
 * A small allowlist suppresses the well-known safe `curl … | sh`
 * installers (Homebrew, rustup, nvm, pnpm, bun, get.docker,
 * install.python-poetry).
 */

export interface ObfuscationFinding {
    matchedPatterns: string[];
    reasons: string[];
}

interface ObfuscationPattern {
    id: string;
    description: string;
    regex: RegExp;
}

const SHELLS = "(?:sh|bash|zsh|dash|ksh|fish)";

const PATTERNS: ObfuscationPattern[] = [
    {
        id: "base64-pipe-exec",
        description: "Base64 decode piped to shell execution",
        regex: new RegExp(`base64\\s+(?:-d|--decode)\\b.*\\|\\s*${SHELLS}\\b`, "i"),
    },
    {
        id: "hex-pipe-exec",
        description: "Hex decode (xxd) piped to shell execution",
        regex: new RegExp(`xxd\\s+-r\\b.*\\|\\s*${SHELLS}\\b`, "i"),
    },
    {
        id: "printf-pipe-exec",
        description: "printf with escape sequences piped to shell execution",
        regex: new RegExp(`printf\\s+.*\\\\x[0-9a-fA-F]{2}.*\\|\\s*${SHELLS}\\b`, "i"),
    },
    {
        id: "eval-decode",
        description: "eval with encoded/decoded input",
        regex: /eval\s+.*(?:base64|xxd|printf|decode)/i,
    },
    {
        id: "command-substitution-decode-exec",
        description: "Shell -c with command substitution decode/obfuscation",
        regex: new RegExp(
            `${SHELLS}\\s+-c\\s+["'][^"']*\\$\\([^)]*` +
            `(?:base64\\s+(?:-d|--decode)|xxd\\s+-r|printf\\s+.*\\\\x[0-9a-fA-F]{2})` +
            `[^)]*\\)[^"']*["']`,
            "i",
        ),
    },
    {
        id: "process-substitution-remote-exec",
        description: "Shell process substitution from remote content",
        regex: new RegExp(`${SHELLS}\\s+<\\(\\s*(?:curl|wget)\\b`, "i"),
    },
    {
        id: "source-process-substitution-remote",
        description: "source/. with process substitution from remote content",
        regex: /(?:^|[;&\s])(?:source|\.)\s+<\(\s*(?:curl|wget)\b/i,
    },
    {
        id: "shell-heredoc-exec",
        description: "Shell heredoc execution",
        regex: new RegExp(`${SHELLS}\\s+<<-?\\s*['"]?[a-zA-Z_][\\w-]*['"]?`, "i"),
    },
    {
        id: "octal-escape",
        description: "Bash octal escape sequences (potential command obfuscation)",
        regex: /\$'(?:[^']*\\[0-7]{3}){2,}/,
    },
    {
        id: "hex-escape",
        description: "Bash hex escape sequences (potential command obfuscation)",
        regex: /\$'(?:[^']*\\x[0-9a-fA-F]{2}){2,}/,
    },
    {
        id: "python-exec-encoded",
        description: "Python/Perl/Ruby with base64 or encoded execution",
        regex: /(?:python[23]?|perl|ruby)\s+-[ec]\s+.*(?:base64|b64decode|decode|exec|system|eval)/i,
    },
    {
        id: "curl-pipe-shell",
        description: "Remote content (curl/wget) piped to shell execution",
        regex: new RegExp(`(?:curl|wget)\\s+.*\\|\\s*${SHELLS}\\b`, "i"),
    },
    {
        id: "var-expansion-obfuscation",
        description: "Variable assignment chain with expansion (potential obfuscation)",
        regex: /(?:[a-zA-Z_]\w{0,2}=\S+\s*;\s*){2,}.*\$(?:[a-zA-Z_]|\{[a-zA-Z_])/,
    },
];

interface FalsePositiveSuppression {
    suppresses: string[];
    regex: RegExp;
}

const SUPPRESSIONS: FalsePositiveSuppression[] = [
    {
        suppresses: ["curl-pipe-shell"],
        regex: /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/Homebrew|brew\.sh)\b/i,
    },
    {
        suppresses: ["curl-pipe-shell"],
        regex:
            /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/nvm-sh\/nvm|sh\.rustup\.rs|get\.docker\.com|install\.python-poetry\.org)\b/i,
    },
    {
        suppresses: ["curl-pipe-shell"],
        regex: /curl\s+.*https?:\/\/(?:get\.pnpm\.io|bun\.sh\/install)\b/i,
    },
];

const URL_RE = /https?:\/\/\S+/g;

/**
 * Return a finding if the command looks obfuscated, else `null`.
 *
 * Each finding lists the matched pattern ids and human descriptions.
 * Suppressions only apply when the command contains at most one URL —
 * chained "curl ... | curl ... | sh" is never auto-suppressed.
 */
export function detectObfuscation(command: string): ObfuscationFinding | null {
    if (!command || !command.trim()) return null;

    const urlCount = (command.match(URL_RE) ?? []).length;

    const matchedIds: string[] = [];
    const reasons: string[] = [];

    for (const pattern of PATTERNS) {
        if (!pattern.regex.test(command)) continue;

        let suppressed = false;
        if (urlCount <= 1) {
            for (const supp of SUPPRESSIONS) {
                if (supp.suppresses.includes(pattern.id) && supp.regex.test(command)) {
                    suppressed = true;
                    break;
                }
            }
        }
        if (suppressed) continue;

        matchedIds.push(pattern.id);
        reasons.push(pattern.description);
    }

    if (matchedIds.length === 0) return null;
    return { matchedPatterns: matchedIds, reasons };
}
