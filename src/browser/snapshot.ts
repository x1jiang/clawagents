/**
 * Accessibility-tree snapshot → text representation with `@eN` refs.
 *
 * Mirrors the Python implementation in
 * `clawagents/browser/snapshot.py` so cross-port behavior stays
 * identical: same role classification, same DFS ordering, same
 * `MAX_NODES = 1500` cap, same `@e1`, `@e2`, … counter scheme.
 *
 * The agent never sees raw HTML or CSS selectors. Refs are scoped
 * per-snapshot — older refs from a stale snapshot fail with
 * {@link ElementNotFoundError}.
 */

import { ElementNotFoundError } from "./errors.js";

/** Roles that produce an `@eN` ref the agent can target. */
const REFFED_ROLES: ReadonlySet<string> = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio",
    "combobox", "listbox", "menuitem", "tab", "switch", "slider",
    "spinbutton", "treeitem", "option", "menuitemcheckbox",
    "menuitemradio", "image",
]);

/** Roles kept in the indented output but not given a `@eN` ref. */
const INFORMATIONAL_ROLES: ReadonlySet<string> = new Set([
    "heading", "paragraph", "text", "list", "listitem", "table",
    "row", "cell", "columnheader", "rowheader", "main", "navigation",
    "banner", "contentinfo", "form", "region", "article", "section",
    "complementary", "dialog", "alertdialog", "alert", "status",
    "tooltip", "group", "separator", "presentation", "img",
]);

export interface AxNode {
    role?: string;
    name?: string;
    value?: string | number | boolean | null;
    children?: AxNode[];
    [key: string]: unknown;
}

/**
 * A single addressable element in a {@link BrowserSnapshot}.
 *
 * `selector` is *not* a CSS selector — it's an opaque payload
 * (a JSON path through the accessibility tree) the session knows
 * how to resolve back to a Playwright handle.
 */
export interface SnapshotElement {
    /** `"@e1"`, `"@e2"`, … */
    ref: string;
    role: string;
    name: string;
    value?: string;
    selector: { path: number[] };
}

export interface BrowserSnapshot {
    /** Final URL after redirects. */
    url: string;
    /** `document.title`. */
    title: string;
    /** Indented text representation passed to the LLM. */
    text: string;
    /** Mapping `"@e1" -> SnapshotElement`. */
    elements: Map<string, SnapshotElement>;
    /** `true` when the tree was clipped to {@link MAX_NODES}. */
    truncated: boolean;
    /**
     * Resolve a `@eN` ref or throw {@link ElementNotFoundError}.
     */
    lookup: (ref: string) => SnapshotElement;
}

/** Hard cap on the number of nodes we render to keep prompts cheap. */
export const MAX_NODES = 1500;

interface WalkContext {
    elements: Map<string, SnapshotElement>;
    lines: string[];
    counter: { value: number };
    path: number[];
}

function walk(node: AxNode, depth: number, ctx: WalkContext): void {
    if (ctx.counter.value >= MAX_NODES) return;

    const role = (node.role ?? "") as string;
    const name = ((node.name ?? "") as string).trim();
    const rawValue = node.value;
    const value = typeof rawValue === "string" ? rawValue : undefined;
    const children = (node.children ?? []) as AxNode[];

    const indent = "  ".repeat(depth);
    let label = "";
    let nextDepth = depth;

    if (REFFED_ROLES.has(role)) {
        ctx.counter.value += 1;
        const ref = `@e${ctx.counter.value}`;
        ctx.elements.set(ref, {
            ref,
            role,
            name,
            value,
            selector: { path: [...ctx.path] },
        });
        let descriptor = name ? `${role} "${name}"` : role;
        if (value) descriptor += ` value="${value}"`;
        label = `${ref} ${descriptor}`;
    } else if (INFORMATIONAL_ROLES.has(role)) {
        if (name) label = `${role}: ${name}`;
        else if (role && children.length === 0) label = role;
    } else if (role) {
        if (name) label = `${role}: ${name}`;
    }

    if (label) {
        ctx.lines.push(`${indent}${label}`);
        nextDepth = depth + 1;
    }

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || typeof child !== "object") continue;
        ctx.path.push(i);
        walk(child, nextDepth, ctx);
        ctx.path.pop();
    }
}

/**
 * Convert a raw Playwright accessibility tree into a snapshot.
 *
 * Accepts `null` (page that doesn't have an accessibility tree, e.g.
 * `about:blank`) and returns an empty snapshot in that case.
 */
export function renderSnapshot(
    tree: AxNode | null | undefined,
    args: { url: string; title: string },
): BrowserSnapshot {
    const elements = new Map<string, SnapshotElement>();
    const lines: string[] = [];
    const counter = { value: 0 };

    if (tree && typeof tree === "object") {
        walk(tree, 0, { elements, lines, counter, path: [] });
    }

    const text = lines.length > 0 ? lines.join("\n") : "(empty page)";
    const truncated = counter.value >= MAX_NODES;

    const lookup = (ref: string): SnapshotElement => {
        const el = elements.get(ref);
        if (!el) {
            throw new ElementNotFoundError(
                `Ref '${ref}' not in current snapshot. ` +
                "Re-snapshot the page (refs reset on every snapshot).",
            );
        }
        return el;
    };

    return {
        url: args.url,
        title: args.title,
        text,
        elements,
        truncated,
        lookup,
    };
}
