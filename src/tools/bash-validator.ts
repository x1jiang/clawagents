/**
 * Bash semantic validator.
 *
 * Inspired by `claw-code-main/rust/crates/runtime/src/bash_validation.rs`.
 * We classify the *first* program name in a shell command and combine
 * that with shape heuristics on the argument list to reach a category
 * and an ALLOW/WARN/BLOCK decision.
 *
 * Public API: {@link validateBash} returning {@link BashDecision}.
 */

export enum CommandCategory {
    READ_ONLY = "READ_ONLY",
    WRITE = "WRITE",
    DESTRUCTIVE = "DESTRUCTIVE",
    NETWORK = "NETWORK",
    PROCESS = "PROCESS",
    PACKAGE = "PACKAGE",
    SYSTEM_ADMIN = "SYSTEM_ADMIN",
    UNKNOWN = "UNKNOWN",
}

export enum Decision {
    ALLOW = "ALLOW",
    WARN = "WARN",
    BLOCK = "BLOCK",
}

export interface BashDecision {
    category: CommandCategory;
    decision: Decision;
    reason: string;
    matchedPattern: string;
}

const READ_ONLY_PROGRAMS = new Set([
    "ls", "cat", "head", "tail", "wc", "which", "whereis", "pwd",
    "echo", "printf", "true", "false", "type", "command",
    "grep", "egrep", "fgrep", "rg", "ag",
    "sort", "uniq", "tr", "cut", "awk",
    "diff", "cmp", "stat", "file", "du", "df",
    "env", "date", "uptime", "id", "whoami", "hostname",
    "ps", "top", "htop",
    "tree", "basename", "dirname", "realpath", "readlink",
    "find",
]);

const PACKAGE_PROGRAMS = new Set([
    "apt", "apt-get", "yum", "dnf", "pacman", "brew",
    "pip", "pip3", "pipx", "uv",
    "npm", "yarn", "pnpm", "bun",
    "cargo", "gem", "go", "rustup",
    "poetry", "conda", "mamba",
]);

const PROCESS_PROGRAMS = new Set([
    "kill", "pkill", "killall", "xkill",
]);

const SYSTEM_ADMIN_PROGRAMS = new Set([
    "sudo", "su", "doas",
    "systemctl", "service", "launchctl",
    "mount", "umount",
    "useradd", "userdel", "usermod", "groupadd", "groupdel",
    "chmod", "chown", "chgrp",
    "iptables", "ufw", "pfctl",
    "reboot", "shutdown", "halt", "poweroff",
]);

const NETWORK_PROGRAMS = new Set([
    "curl", "wget", "ssh", "scp", "rsync", "ftp", "sftp",
    "nc", "netcat", "telnet", "nslookup", "dig", "host",
]);

const WRITE_PROGRAMS = new Set([
    "cp", "mv", "mkdir", "rmdir", "touch", "ln", "install", "tee",
    "truncate", "mkfifo", "mknod",
]);

const FORK_BOMB_RE = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const REDIRECT_TO_BLOCK_DEV_RE = />\s*\/dev\/(?:sd[a-z]+|nvme\d+|hd[a-z]+|disk\d+)/;
const GIT_READ_SUBCMD = new Set([
    "status", "log", "diff", "show", "blame", "branch", "remote",
    "config", "describe", "ls-files", "ls-tree", "rev-parse",
    "stash", "tag",
]);

/**
 * Tokenize the head command of a (possibly compound) shell line.
 * Strips leading env-var assignments (FOO=bar baz). Splits on the first
 * occurrence of ;, &&, ||, or | so we look at the head command only.
 */
function splitFirstToken(command: string): { program: string; tokens: string[] } {
    let s = command.trim();
    // Strip env-var assignments at the front.
    while (s && /^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
        const idx = s.indexOf(" ");
        if (idx < 0) break;
        s = s.slice(idx + 1).replace(/^\s+/, "");
    }
    // Truncate at the first compound separator.
    const m = s.match(/\s*(?:\|\||&&|;|\|)\s*/);
    const head = m && m.index !== undefined ? s.slice(0, m.index) : s;

    // Naive token split that preserves quoted strings as single tokens.
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(head)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
    if (tokens.length === 0) return { program: "", tokens: [] };
    return { program: tokens[0], tokens };
}

function classifyRm(tokens: string[]): BashDecision {
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
    const paths = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const hasRecursive = flags.some((f) => /[rR]/.test(f.replace(/^-+/, "")));
    const hasForce = flags.some((f) => /f/.test(f.replace(/^-+/, "")));
    const badTargets = new Set(["/", "/*", ".", "./*", "..", "*", "~", "~/"]);
    if (paths.some((p) => badTargets.has(p)) && (hasRecursive || hasForce)) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: `rm with recursive/force on root-like target (${JSON.stringify(paths)})`,
            matchedPattern: "rm -rf <root>",
        };
    }
    if (hasRecursive && hasForce) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.WARN,
            reason: "rm -rf is destructive; review the path carefully",
            matchedPattern: "rm -rf",
        };
    }
    return {
        category: CommandCategory.DESTRUCTIVE,
        decision: Decision.WARN,
        reason: "rm removes files; review the path",
        matchedPattern: "rm",
    };
}

function classifyDd(tokens: string[]): BashDecision {
    const joined = tokens.join(" ");
    if (/\bof=\/dev\/(?:sd|nvme|hd|disk)/.test(joined)) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "dd writing to a block device wipes the disk",
            matchedPattern: "dd of=/dev/sd*",
        };
    }
    return {
        category: CommandCategory.DESTRUCTIVE,
        decision: Decision.WARN,
        reason: "dd performs raw disk writes; review the of= target",
        matchedPattern: "dd",
    };
}

function classifyFind(tokens: string[]): BashDecision {
    const args = tokens.slice(1);
    if (args.includes("-delete")) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "find -delete recursively removes matched paths",
            matchedPattern: "find -delete",
        };
    }
    const execIdx = args.indexOf("-exec");
    if (execIdx >= 0 && execIdx + 1 < args.length && args[execIdx + 1].endsWith("rm")) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "find -exec rm recursively removes matched paths",
            matchedPattern: "find -exec rm",
        };
    }
    return {
        category: CommandCategory.READ_ONLY,
        decision: Decision.ALLOW,
        reason: "find without -delete/-exec rm is read-only",
        matchedPattern: "find",
    };
}

function classifyChmodChown(tokens: string[]): BashDecision {
    const program = tokens[0];
    const args = tokens.slice(1);
    const hasRecursive = args.some((t) => t === "-R" || t === "--recursive");
    const targets = args.filter((t) => !t.startsWith("-"));
    if (
        program === "chmod" &&
        args.includes("777") &&
        hasRecursive &&
        targets.some((t) => t === "/" || t === "/*")
    ) {
        return {
            category: CommandCategory.SYSTEM_ADMIN,
            decision: Decision.WARN,
            reason: "chmod -R 777 / opens the entire filesystem; reviewing",
            matchedPattern: "chmod -R 777 /",
        };
    }
    if (program === "chown" && hasRecursive && targets.some((t) => t.includes("root"))) {
        return {
            category: CommandCategory.SYSTEM_ADMIN,
            decision: Decision.WARN,
            reason: "chown -R root touches ownership at scale; reviewing",
            matchedPattern: "chown -R root",
        };
    }
    return {
        category: CommandCategory.SYSTEM_ADMIN,
        decision: Decision.WARN,
        reason: `${program} modifies permissions/ownership`,
        matchedPattern: program,
    };
}

function classifyPackage(tokens: string[]): BashDecision {
    const program = tokens[0];
    const args = tokens.slice(1);
    const sub = args[0] ?? "";
    const mutating = new Set([
        "install", "uninstall", "remove", "rm", "add", "i",
        "upgrade", "update", "publish", "unpublish",
    ]);
    if (mutating.has(sub)) {
        return {
            category: CommandCategory.PACKAGE,
            decision: Decision.WARN,
            reason: `${program} ${sub} mutates installed packages`,
            matchedPattern: `${program} ${sub}`,
        };
    }
    return {
        category: CommandCategory.PACKAGE,
        decision: Decision.ALLOW,
        reason: `${program} ${sub || "<noop>"} appears non-mutating`,
        matchedPattern: program,
    };
}

function classifyGit(tokens: string[]): BashDecision {
    const args = tokens.slice(1);
    const sub = args[0] ?? "";
    if (GIT_READ_SUBCMD.has(sub)) {
        return {
            category: CommandCategory.READ_ONLY,
            decision: Decision.ALLOW,
            reason: `git ${sub} is read-only`,
            matchedPattern: `git ${sub}`,
        };
    }
    if (["reset", "clean", "rebase", "checkout", "restore", "switch", "rm", "mv"].includes(sub)) {
        return {
            category: CommandCategory.WRITE,
            decision: Decision.WARN,
            reason: `git ${sub} can rewrite/discard local changes`,
            matchedPattern: `git ${sub}`,
        };
    }
    if (["push", "pull", "fetch", "clone", "submodule"].includes(sub)) {
        return {
            category: CommandCategory.NETWORK,
            decision: sub === "push" ? Decision.WARN : Decision.ALLOW,
            reason: `git ${sub} interacts with remotes`,
            matchedPattern: `git ${sub}`,
        };
    }
    if (["commit", "add", "stash", "merge", "tag"].includes(sub)) {
        return {
            category: CommandCategory.WRITE,
            decision: Decision.ALLOW,
            reason: `git ${sub} mutates the local repo`,
            matchedPattern: `git ${sub}`,
        };
    }
    return {
        category: CommandCategory.UNKNOWN,
        decision: Decision.ALLOW,
        reason: `git ${sub || "<noop>"} not specifically classified`,
        matchedPattern: "git",
    };
}

function classifySed(tokens: string[]): BashDecision {
    const args = tokens.slice(1);
    const inPlace = args.some(
        (a) => a === "-i" || (a.startsWith("-i") && !a.startsWith("--include")),
    );
    if (inPlace) {
        return {
            category: CommandCategory.WRITE,
            decision: Decision.WARN,
            reason: "sed -i edits files in place",
            matchedPattern: "sed -i",
        };
    }
    return {
        category: CommandCategory.READ_ONLY,
        decision: Decision.ALLOW,
        reason: "sed without -i is read-only",
        matchedPattern: "sed",
    };
}

/**
 * Classify a bash command and decide ALLOW / WARN / BLOCK.
 *
 * The decision is advisory: callers (the exec tool) decide what to do
 * with WARN — typically prepending a notice to the output and proceeding.
 * BLOCK should always cause a refusal.
 */
export function validateBash(command: string): BashDecision {
    const raw = (command ?? "").trim();
    if (!raw) {
        return {
            category: CommandCategory.UNKNOWN,
            decision: Decision.ALLOW,
            reason: "empty command",
            matchedPattern: "",
        };
    }

    if (FORK_BOMB_RE.test(raw)) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "fork bomb detected",
            matchedPattern: ":(){ :|:& };:",
        };
    }
    if (REDIRECT_TO_BLOCK_DEV_RE.test(raw)) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "redirect into a block device wipes the disk",
            matchedPattern: "> /dev/sd*",
        };
    }

    const { program, tokens } = splitFirstToken(raw);
    if (!program) {
        return {
            category: CommandCategory.UNKNOWN,
            decision: Decision.ALLOW,
            reason: "no program name found",
            matchedPattern: "",
        };
    }

    if (program === "rm") return classifyRm(tokens);
    if (program === "dd") return classifyDd(tokens);
    if (program === "find") return classifyFind(tokens);
    if (program === "shred") {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "shred overwrites and removes files irreversibly",
            matchedPattern: "shred",
        };
    }
    if (program.startsWith("mkfs")) {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "mkfs formats a filesystem",
            matchedPattern: "mkfs.*",
        };
    }
    if (program === "truncate") {
        return {
            category: CommandCategory.DESTRUCTIVE,
            decision: Decision.BLOCK,
            reason: "truncate can zero-out files",
            matchedPattern: "truncate",
        };
    }

    if (["chmod", "chown", "chgrp"].includes(program)) return classifyChmodChown(tokens);

    if (program === "git") return classifyGit(tokens);
    if (program === "sed") return classifySed(tokens);

    if (PACKAGE_PROGRAMS.has(program)) return classifyPackage(tokens);

    if (PROCESS_PROGRAMS.has(program)) {
        return {
            category: CommandCategory.PROCESS,
            decision: Decision.WARN,
            reason: `${program} terminates processes`,
            matchedPattern: program,
        };
    }
    if (SYSTEM_ADMIN_PROGRAMS.has(program)) {
        return {
            category: CommandCategory.SYSTEM_ADMIN,
            decision: Decision.WARN,
            reason: `${program} performs system administration`,
            matchedPattern: program,
        };
    }
    if (NETWORK_PROGRAMS.has(program)) {
        return {
            category: CommandCategory.NETWORK,
            decision: Decision.ALLOW,
            reason: `${program} talks to the network`,
            matchedPattern: program,
        };
    }
    if (WRITE_PROGRAMS.has(program)) {
        return {
            category: CommandCategory.WRITE,
            decision: Decision.ALLOW,
            reason: `${program} modifies the filesystem`,
            matchedPattern: program,
        };
    }
    if (READ_ONLY_PROGRAMS.has(program)) {
        return {
            category: CommandCategory.READ_ONLY,
            decision: Decision.ALLOW,
            reason: `${program} is read-only`,
            matchedPattern: program,
        };
    }

    return {
        category: CommandCategory.UNKNOWN,
        decision: Decision.ALLOW,
        reason: `${program} not specifically classified; default ALLOW`,
        matchedPattern: program,
    };
}
