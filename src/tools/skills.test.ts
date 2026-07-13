/**
 * Skill loading/use mechanism regressions (mirrors
 * clawagents_py/tests/test_skill_loading_mechanism.py).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SkillStore,
    createSkillTools,
    parseSkillFile,
    isSkillEligible,
    skillIneligibilityReason,
    resolveSkill,
    suggestSkills,
} from "./skills.js";

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "claw-skills-"));
}

function writeSkill(
    root: string,
    name: string,
    opts: { body?: string; frontmatter?: string } = {},
): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const fm = opts.frontmatter ?? `name: ${name}\ndescription: ${name} skill`;
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${opts.body ?? "Do the thing."}\n`);
    return dir;
}

test("later directory overrides earlier on name collision", async () => {
    const root = makeRoot();
    try {
        const low = join(root, "bundled");
        const high = join(root, "workspace");
        writeSkill(low, "caveman", { body: "bundled body" });
        writeSkill(high, "caveman", { body: "workspace body" });

        const store = new SkillStore();
        store.addDirectory(low);
        store.addDirectory(high);
        await store.loadAll();

        assert.equal(store.get("caveman")?.content, "workspace body");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("addDirectory dedups repeated paths", () => {
    const root = makeRoot();
    try {
        writeSkill(root, "demo");
        const store = new SkillStore();
        store.addDirectory(root);
        store.addDirectory(root);
        assert.equal((store as any).skillDirs.length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("metadata block keys do not gate eligibility", () => {
    const content = [
        "---",
        "name: demo",
        "description: A demo",
        "metadata:",
        "  env: production",
        "  os: solaris",
        "  bins: nonexistent-binary-xyz",
        "---",
        "",
        "Body.",
        "",
    ].join("\n");
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    assert.equal(skill.requires, undefined);
    assert.ok(isSkillEligible(skill));
});

test("scoped requires block parses inline and block lists", () => {
    const content = [
        "---",
        "name: demo",
        "description: A demo",
        "requires:",
        "  bins: [definitely-not-a-real-binary-xyz]",
        "  env:",
        "    - CLAW_TEST_DEFINITELY_UNSET_VAR",
        "---",
        "",
        "Body.",
        "",
    ].join("\n");
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    assert.deepEqual(skill.requires?.bins, ["definitely-not-a-real-binary-xyz"]);
    assert.deepEqual(skill.requires?.env, ["CLAW_TEST_DEFINITELY_UNSET_VAR"]);
    assert.match(skillIneligibilityReason(skill) ?? "", /missing binary/);
});

test("openclaw JSON metadata requires are honored", () => {
    const content = [
        "---",
        "name: demo",
        "description: A demo",
        'metadata: {"openclaw": {"requires": {"bins": ["definitely-not-a-real-binary-xyz"]}}}',
        "---",
        "",
        "Body.",
        "",
    ].join("\n");
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    assert.deepEqual(skill.requires?.bins, ["definitely-not-a-real-binary-xyz"]);
});

test("os aliases normalize to process.platform values", () => {
    const content = `---\nname: demo\ndescription: d\nrequires.os: macos, windows, linux\n---\n\nBody.\n`;
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    // Current platform is one of darwin/win32/linux, all covered by aliases.
    assert.ok(isSkillEligible(skill));
});

test("os mismatch reports a reason", () => {
    const other = process.platform === "linux" ? "windows" : "linux";
    const content = `---\nname: demo\ndescription: d\nrequires.os: ${other}\n---\n\nBody.\n`;
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    assert.match(skillIneligibilityReason(skill) ?? "", /requires os/);
});

test("frontmatter closing at EOF still parses", () => {
    const content = "---\nname: eof-skill\ndescription: ends at delimiter\n---";
    const skill = parseSkillFile(content, "/tmp/eof-skill/SKILL.md");
    assert.equal(skill.name, "eof-skill");
    assert.equal(skill.description, "ends at delimiter");
    assert.equal(skill.content, "");
});

test("dir skill defaults name to directory", () => {
    const skill = parseSkillFile("No frontmatter, just instructions.\n", "/skills/pdf-tools/SKILL.md");
    assert.equal(skill.name, "pdf-tools");
});

test("block scalar description parses", () => {
    const content = [
        "---",
        "name: demo",
        "description: |",
        "  First line of description.",
        "  Second line with cohort SQL hints.",
        "---",
        "",
        "Body here.",
        "",
    ].join("\n");
    const skill = parseSkillFile(content, "/tmp/demo/SKILL.md");
    assert.match(skill.description, /First line/);
    assert.match(skill.description, /cohort SQL/);
});

test("description falls back to first body line", () => {
    const content = "---\nname: bare\n---\n\n# Heading\n\nUse this to convert PDFs.\n";
    const skill = parseSkillFile(content, "/tmp/bare/SKILL.md");
    assert.equal(skill.description, "Use this to convert PDFs.");
});

test("spec violations warn but load", () => {
    const content = "---\nname: Bad_Name_Here\ndescription: d\n---\n\nBody.\n";
    const skill = parseSkillFile(content, "/tmp/other-dir/SKILL.md");
    assert.equal(skill.name, "Bad_Name_Here");
    assert.ok(skill.warnings?.some((w) => w.includes("not spec-conformant")));
    assert.ok(skill.warnings?.some((w) => w.includes("does not match its directory")));
});

test("README not loaded as skill; ineligible tracked with reason", async () => {
    const root = makeRoot();
    try {
        writeFileSync(join(root, "README.md"), "# About these skills\n");
        writeSkill(root, "real-skill");
        writeSkill(root, "gated", {
            frontmatter:
                "name: gated\ndescription: d\nrequires:\n  bins: [definitely-not-a-real-binary-xyz]",
        });
        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        assert.deepEqual(store.list().map((s) => s.name), ["real-skill"]);
        assert.match(store.ineligible.get("gated") ?? "", /missing binary/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("list_skills reports unavailable skills with reasons", async () => {
    const root = makeRoot();
    try {
        writeSkill(root, "ok-skill");
        writeSkill(root, "gated", {
            frontmatter:
                "name: gated\ndescription: d\nrequires:\n  bins: [definitely-not-a-real-binary-xyz]",
        });
        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        const listTool = createSkillTools(store).find((t) => t.name === "list_skills")!;
        const result = await listTool.execute({});
        assert.ok(result.success);
        assert.match(String(result.output), /ok-skill/);
        assert.match(String(result.output), /Unavailable \(requirements not met\)/);
        assert.match(String(result.output), /missing binary/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("use_skill includes base dir and bundled resources", async () => {
    const root = makeRoot();
    try {
        const dir = writeSkill(root, "with-scripts", { body: "Run scripts/run.py to start." });
        mkdirSync(join(dir, "scripts"));
        writeFileSync(join(dir, "scripts", "run.py"), "print('hi')\n");
        mkdirSync(join(dir, "references"));
        writeFileSync(join(dir, "references", "guide.md"), "# Guide\n");

        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        const useTool = createSkillTools(store).find((t) => t.name === "use_skill")!;
        const result = await useTool.execute({ name: "with-scripts" });
        assert.ok(result.success);
        assert.ok(String(result.output).includes(`Base directory for this skill: ${dir}`));
        assert.match(String(result.output), /scripts\/run\.py/);
        assert.match(String(result.output), /references\/guide\.md/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("use_skill resolves fuzzy names and suggests on typos", async () => {
    const root = makeRoot();
    try {
        writeSkill(root, "atomic-waterfall-query");
        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        assert.ok(resolveSkill(store, "Atomic_Waterfall_Query"));
        assert.ok(suggestSkills(store, "atomic-waterfal-query").includes("atomic-waterfall-query"));

        const useTool = createSkillTools(store).find((t) => t.name === "use_skill")!;
        const miss = await useTool.execute({ name: "atomic-waterfal" });
        assert.equal(miss.success, false);
        assert.match(miss.error ?? "", /Did you mean/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("use_skill reports ineligible reason on miss", async () => {
    const root = makeRoot();
    try {
        writeSkill(root, "gated", {
            frontmatter:
                "name: gated\ndescription: d\nrequires:\n  env:\n    - CLAW_TEST_DEFINITELY_UNSET_VAR",
        });
        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        const useTool = createSkillTools(store).find((t) => t.name === "use_skill")!;
        const result = await useTool.execute({ name: "gated" });
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /unavailable/);
        assert.match(result.error ?? "", /missing env var/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("disable-model-invocation hides from catalog and refuses use_skill", async () => {
    const root = makeRoot();
    try {
        writeSkill(root, "user-only", {
            frontmatter: "name: user-only\ndescription: d\ndisable-model-invocation: true",
        });
        writeSkill(root, "normal");
        const store = new SkillStore();
        store.addDirectory(root);
        await store.loadAll();

        assert.deepEqual(store.list().map((s) => s.name), ["normal"]);
        assert.equal(store.listAll().length, 2);

        const useTool = createSkillTools(store).find((t) => t.name === "use_skill")!;
        const result = await useTool.execute({ name: "user-only" });
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /disable-model-invocation/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
