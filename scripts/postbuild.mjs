#!/usr/bin/env node
/**
 * Post-build helper:
 *   - Ensure dist/cli.js has a Node shebang so `bin` works.
 *   - Make dist/cli.js executable (chmod +x).
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

if (!existsSync(cliPath)) {
    console.error(`[postbuild] missing ${cliPath} — did tsc emit anything?`);
    process.exit(1);
}

const SHEBANG = "#!/usr/bin/env node\n";
const original = readFileSync(cliPath, "utf-8");
if (!original.startsWith("#!")) {
    writeFileSync(cliPath, SHEBANG + original);
    console.log("[postbuild] prepended shebang to dist/cli.js");
}

chmodSync(cliPath, 0o755);
console.log("[postbuild] chmod +x dist/cli.js");
