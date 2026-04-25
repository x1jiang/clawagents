/**
 * Display-layer secret redaction for ClawAgents.
 *
 * This module strips API-key-like patterns from text before it reaches:
 *
 *  - the terminal (CLI streaming output, banners, error traces),
 *  - gateway / channel chats (Telegram, Signal, WhatsApp, gateway WS),
 *  - trajectory NDJSON files,
 *  - diagnostic and debug logs.
 *
 * Inspired by ``hermes-agent``'s ``agent/redact.py``. Redaction is applied at
 * the **display / persistence layer only** — underlying values still flow
 * through the agent loop unchanged so tools that legitimately need a secret
 * (e.g. an authenticated API call) keep working.
 *
 * Redaction is **enabled by default**. Operators may opt out per-process via
 * the ``CLAW_REDACT`` environment variable:
 *
 *  - ``CLAW_REDACT=0`` / ``false`` / ``no`` → redaction disabled.
 *  - ``CLAW_REDACT=warn`` → redaction disabled but a single warning is logged
 *    the first time a secret-like pattern would have been redacted.
 *
 * Custom patterns can be added at runtime via :func:`addPattern`. Built-in
 * coverage matches the Python sibling — see ``redact.py`` for the canonical
 * pattern list.
 */

interface PatternEntry {
    label: string;
    pattern: RegExp;
}

function compile(label: string, pattern: string, flags = "g"): PatternEntry {
    return { label, pattern: new RegExp(pattern, flags) };
}

const BUILTIN_PATTERNS: readonly PatternEntry[] = [
    compile("OPENAI_KEY", "\\bsk-(?:proj-)?[A-Za-z0-9_\\-]{20,}\\b"),
    compile("ANTHROPIC_KEY", "\\bsk-ant-[A-Za-z0-9_\\-]{20,}\\b"),
    compile("GOOGLE_KEY", "\\bAIza[0-9A-Za-z_\\-]{35}\\b"),
    compile(
        "GITHUB_TOKEN",
        "\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\\b",
    ),
    compile("AWS_ACCESS_KEY_ID", "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b"),
    compile("SLACK_TOKEN", "\\bxox[abprs]-[A-Za-z0-9\\-]{10,}\\b"),
    compile(
        "JWT",
        "\\beyJ[A-Za-z0-9_=\\-]{4,}\\.[A-Za-z0-9_=\\-]{4,}\\.[A-Za-z0-9_.+/=\\-]{4,}\\b",
    ),
    compile(
        "BEARER",
        "\\b(?:authorization|bearer)\\s*[:=]\\s*['\\\"]?[A-Za-z0-9_\\-.~+/=]{16,}['\\\"]?",
        "gi",
    ),
    compile(
        "GENERIC_SECRET",
        "\\b(?:api[_-]?key|api[_-]?secret|password|passwd|pwd|secret|" +
            "client[_-]?secret|access[_-]?token|refresh[_-]?token|" +
            "private[_-]?key|x[_-]?api[_-]?key)" +
            "\\s*[:=]\\s*['\\\"]?([A-Za-z0-9_\\-+/=.~]{8,})['\\\"]?",
        "gi",
    ),
];

const userPatterns: PatternEntry[] = [];
let warnedOnce = false;

type RedactMode = "on" | "warn" | "off";

function redactMode(): RedactMode {
    const raw = (process.env["CLAW_REDACT"] ?? "").trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(raw)) return "off";
    if (raw === "warn" || raw === "warning") return "warn";
    return "on";
}

/**
 * Register a custom regex pattern. Matched substrings are replaced with
 * ``[REDACTED:<label>]`` on every subsequent :func:`redact` call. ``pattern``
 * may be a string (compiled with the ``g`` flag) or an existing ``RegExp``
 * (must be global to avoid silently matching only once).
 */
export function addPattern(label: string, pattern: string | RegExp): void {
    let re: RegExp;
    if (typeof pattern === "string") {
        re = new RegExp(pattern, "g");
    } else if (pattern.flags.includes("g")) {
        re = pattern;
    } else {
        re = new RegExp(pattern.source, pattern.flags + "g");
    }
    userPatterns.push({ label, pattern: re });
}

/** Drop all user-registered patterns. Built-in patterns are unaffected. */
export function resetPatterns(): void {
    userPatterns.length = 0;
}

/**
 * Return ``text`` with API-key-like substrings replaced.
 *
 * If ``label`` is ``true`` (default), each match becomes
 * ``[REDACTED:<KIND>]``; otherwise a fixed ``[REDACTED]``.
 *
 * Returns the empty string for ``null``/``undefined`` to keep callsites
 * simple.
 */
export function redact(
    text: string | null | undefined,
    opts: { label?: boolean } = {},
): string {
    if (text == null) return "";
    if (typeof text !== "string") text = String(text);
    if (text.length === 0) return text;

    const mode = redactMode();
    if (mode === "off") return text;

    let out = text;
    let matched = false;
    const labeled = opts.label ?? true;

    for (const { label, pattern } of [...BUILTIN_PATTERNS, ...userPatterns]) {
        const replacement = labeled ? `[REDACTED:${label}]` : "[REDACTED]";
        const next = out.replace(pattern, replacement);
        if (next !== out) {
            matched = true;
            out = next;
        }
    }

    if (matched && mode === "warn") {
        if (!warnedOnce) {
            console.warn(
                "[clawagents.redact] detected secret-like content but CLAW_REDACT=warn (redaction disabled). " +
                    "Set CLAW_REDACT=1 to enable.",
            );
            warnedOnce = true;
        }
        return text;
    }

    return out;
}

/**
 * Recursively redact string leaves inside arrays / plain objects. Non-string
 * scalars pass through. ``Map``/``Set`` are converted to plain forms first.
 */
export function redactObj<T = unknown>(obj: T): T {
    if (obj == null) return obj;
    if (typeof obj === "string") return redact(obj) as unknown as T;
    if (Array.isArray(obj)) return obj.map(redactObj) as unknown as T;
    if (typeof obj === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            out[k] = redactObj(v);
        }
        return out as unknown as T;
    }
    return obj;
}

const SECRET_NAME_HINTS = [
    "api_key",
    "api-key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "pwd",
    "token",
    "auth",
    "credential",
    "private_key",
    "access_key",
    "session_key",
    "bearer",
] as const;

/** True if ``name`` looks like an env var / config key holding a secret. */
export function isSecretName(name: string): boolean {
    if (!name) return false;
    const lower = name.toLowerCase();
    return SECRET_NAME_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Return a copy of ``env`` with values for secret-named keys masked.
 *
 * The mask is a fixed ``[REDACTED]`` regardless of whether the value looks
 * like a recognized provider key; both presence and length are hidden.
 */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) {
            out[k] = undefined;
        } else if (isSecretName(k)) {
            out[k] = "[REDACTED]";
        } else if (typeof v === "string") {
            out[k] = redact(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}
