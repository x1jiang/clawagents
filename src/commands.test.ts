/**
 * Tests for `commands.ts` — slash-command registry.
 * Mirrors `clawagents_py/tests/test_commands.py`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    COMMAND_REGISTRY,
    type CommandDef,
    allCommandNames,
    formatHelp,
    listCommands,
    registerCommand,
    resolveCommand,
    _rebuildCommandIndex,
} from "./commands.js";

describe("resolveCommand", () => {
    it("resolves canonical command and trims args", () => {
        const r = resolveCommand("/steer please switch to TypeScript");
        assert.ok(r);
        assert.equal(r.command.name, "steer");
        assert.equal(r.args, "please switch to TypeScript");
    });

    it("alias routes to canonical", () => {
        const r = resolveCommand("/q now do the next thing");
        assert.ok(r);
        assert.equal(r.command.name, "queue");
        assert.equal(r.args, "now do the next thing");
    });

    it("no args yields empty string", () => {
        const r = resolveCommand("/help");
        assert.ok(r);
        assert.equal(r.command.name, "help");
        assert.equal(r.args, "");
    });

    it("strips trailing whitespace in args", () => {
        const r = resolveCommand("/title  My Run   ");
        assert.ok(r);
        assert.equal(r.args, "My Run");
    });

    it("unknown command returns null", () => {
        assert.equal(resolveCommand("/notarealcommand"), null);
    });

    it("non-slash returns null", () => {
        assert.equal(resolveCommand("hello"), null);
        assert.equal(resolveCommand(""), null);
        assert.equal(resolveCommand("/"), null);
    });

    it("command head is case-insensitive", () => {
        const r = resolveCommand("/STEER do the thing");
        assert.ok(r);
        assert.equal(r.command.name, "steer");
        assert.equal(r.args, "do the thing");
    });
});

describe("listCommands", () => {
    it("filters by category", () => {
        const info = listCommands({ category: "Info" });
        assert.ok(info.every((c) => c.category === "Info"));
        assert.ok(info.some((c) => c.name === "help"));
        assert.ok(info.every((c) => c.name !== "steer"));
    });

    it("filters by audience: cli hides gateway-only", () => {
        const cli = listCommands({ audience: "cli" });
        assert.ok(cli.every((c) => !c.gatewayOnly));
    });
});

describe("formatHelp", () => {
    it("groups by category", () => {
        const text = formatHelp();
        assert.ok(text.includes("=== Session ==="));
        assert.ok(text.includes("=== Info ==="));
        assert.ok(text.includes("/steer"));
        assert.ok(text.includes("/help"));
    });

    it("category filter returns just one section", () => {
        const text = formatHelp({ category: "Permission" });
        assert.ok(text.includes("=== Permission ==="));
        assert.ok(!text.includes("=== Session ==="));
    });
});

describe("registerCommand", () => {
    it("appends, then overwrites instead of duplicating", () => {
        const custom: CommandDef = {
            name: "zzz_test",
            description: "ephemeral test command",
            category: "Test",
        };
        registerCommand(custom);
        try {
            const r = resolveCommand("/zzz_test foo");
            assert.ok(r);
            assert.equal(r.args, "foo");

            // Re-register with same name — should replace, not duplicate.
            registerCommand({
                name: "zzz_test",
                description: "replaced description",
                category: "Test",
            });
            const matches = COMMAND_REGISTRY.filter((c) => c.name === "zzz_test");
            assert.equal(matches.length, 1);
            assert.equal(matches[0].description, "replaced description");
        } finally {
            const idx = COMMAND_REGISTRY.findIndex((c) => c.name === "zzz_test");
            if (idx >= 0) COMMAND_REGISTRY.splice(idx, 1);
            _rebuildCommandIndex();
        }
    });

    it("alias on registered command resolves", () => {
        registerCommand({
            name: "zzz_alias_test",
            description: "ephemeral alias test",
            category: "Test",
            aliases: ["zzz_at"],
        });
        try {
            const r = resolveCommand("/zzz_at hello");
            assert.ok(r);
            assert.equal(r.command.name, "zzz_alias_test");
        } finally {
            const idx = COMMAND_REGISTRY.findIndex((c) => c.name === "zzz_alias_test");
            if (idx >= 0) COMMAND_REGISTRY.splice(idx, 1);
            _rebuildCommandIndex();
        }
    });
});

describe("allCommandNames", () => {
    it("includes aliases by default", () => {
        const names = allCommandNames();
        assert.ok(names.includes("queue"));
        assert.ok(names.includes("q"));
    });

    it("canonical only when includeAliases=false", () => {
        const names = allCommandNames({ includeAliases: false });
        assert.ok(names.includes("queue"));
        assert.ok(!names.includes("q"));
    });
});

describe("registry consistency", () => {
    it("no alias collisions in default registry", () => {
        const seen = new Map<string, string>();
        for (const cmd of COMMAND_REGISTRY) {
            for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
                assert.ok(
                    !seen.has(n),
                    `alias/name collision: '${n}' is used by both ${seen.get(n)} and ${cmd.name}`,
                );
                seen.set(n, cmd.name);
            }
        }
    });

    it("core commands are present", () => {
        const names = new Set(COMMAND_REGISTRY.map((c) => c.name));
        for (const required of [
            "new", "save", "compress", "stop",
            "steer", "queue", "background", "agents",
            "plan", "accept-edits", "default", "bypass",
            "help", "status", "version",
        ]) {
            assert.ok(names.has(required), `missing core command: ${required}`);
        }
    });
});

describe("cacheImpact + --now flag", () => {
    it("default cache impact is 'none' and applyNow is false", () => {
        const r = resolveCommand("/help");
        assert.ok(r);
        // cacheImpact may be `undefined` in registry; treat as "none".
        assert.ok(r.command.cacheImpact === undefined || r.command.cacheImpact === "none");
        assert.equal(r.applyNow, false);
    });

    it("'immediate' commands always apply now", () => {
        const r = resolveCommand("/new");
        assert.ok(r);
        assert.equal(r.command.cacheImpact, "immediate");
        assert.equal(r.applyNow, true);
    });

    it("'immediate' commands strip --now from args but stay applyNow=true", () => {
        const r = resolveCommand("/compress focus --now");
        assert.ok(r);
        assert.equal(r.command.name, "compress");
        assert.equal(r.applyNow, true);
        assert.ok(!r.args.includes("--now"));
        assert.equal(r.args, "focus");
    });

    it("'deferred' commands default to applyNow=false", () => {
        const r = resolveCommand("/plan");
        assert.ok(r);
        assert.equal(r.command.cacheImpact, "deferred");
        assert.equal(r.applyNow, false);
    });

    it("'deferred' commands with --now apply immediately", () => {
        const r = resolveCommand("/plan --now");
        assert.ok(r);
        assert.equal(r.applyNow, true);
        assert.equal(r.args, "");
    });

    it("--now flag may appear anywhere in args", () => {
        const r = resolveCommand("/accept-edits --now");
        assert.ok(r);
        assert.equal(r.applyNow, true);
        assert.equal(r.args, "");

        const r2 = resolveCommand("/bypass extra --now noted");
        assert.ok(r2);
        assert.equal(r2.applyNow, true);
        assert.equal(r2.args, "extra noted");
    });

    it("permission-mode commands are marked deferred", () => {
        const byName = new Map(COMMAND_REGISTRY.map((c) => [c.name, c]));
        for (const n of ["plan", "accept-edits", "default", "bypass"]) {
            assert.equal(byName.get(n)!.cacheImpact, "deferred", `cacheImpact for ${n}`);
        }
    });

    it("--now does not promote 'none' commands but is still stripped", () => {
        const r = resolveCommand("/help --now command");
        assert.ok(r);
        assert.ok(r.command.cacheImpact === undefined || r.command.cacheImpact === "none");
        assert.equal(r.applyNow, false);
        assert.ok(!r.args.includes("--now"));
        assert.equal(r.args, "command");
    });
});
