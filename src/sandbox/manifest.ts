export type SandboxManifestEntry =
    | {
        type: "path";
        source: string;
        target?: string;
        readOnly?: boolean;
    }
    | {
        type: "git";
        repo: string;
        ref?: string;
        target?: string;
    };

export interface SandboxManifest {
    entries?: Record<string, SandboxManifestEntry> | SandboxManifestEntry[];
    env?: Record<string, string>;
    workdir?: string;
}

export type NormalizedSandboxManifestEntry = SandboxManifestEntry & { name: string; target: string };

export interface NormalizedSandboxManifest {
    entries: NormalizedSandboxManifestEntry[];
    env: Record<string, string>;
    workdir?: string;
}

function defaultTarget(name: string, entry: SandboxManifestEntry): string {
    if (entry.target) return entry.target;
    if (entry.type === "git") {
        const tail = entry.repo.split("/").filter(Boolean).at(-1) ?? name;
        return tail.replace(/\.git$/, "") || name;
    }
    return name;
}

function normalizeEntry(name: string, entry: SandboxManifestEntry): NormalizedSandboxManifestEntry {
    if (!name.trim()) throw new Error("Sandbox manifest entry name is required");
    if (entry.type === "path" && !entry.source.trim()) {
        throw new Error(`Sandbox manifest path entry '${name}' requires a source`);
    }
    if (entry.type === "git" && !entry.repo.trim()) {
        throw new Error(`Sandbox manifest git entry '${name}' requires a repo`);
    }
    return { ...entry, name, target: defaultTarget(name, entry) };
}

export function normalizeSandboxManifest(manifest: SandboxManifest = {}): NormalizedSandboxManifest {
    const rawEntries = manifest.entries ?? {};
    const entries = Array.isArray(rawEntries)
        ? rawEntries.map((entry, idx) => normalizeEntry(String(idx), entry))
        : Object.entries(rawEntries).map(([name, entry]) => normalizeEntry(name, entry));

    return {
        entries,
        env: { ...(manifest.env ?? {}) },
        workdir: manifest.workdir,
    };
}
