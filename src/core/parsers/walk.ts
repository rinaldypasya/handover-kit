import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor", "target"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".rs", ".php", ".kt", ".cs"]);

/** Repo-relative paths always use "/" so a hash generated on Windows matches one checked on Linux. */
export function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Lightweight recursive source file listing, capped so it stays fast on
 * large repos without pulling in a glob dependency. Good enough for the
 * "scan for TODO/FIXME" use case — not meant to replace `git ls-files`.
 *
 * Traversal is explicitly sorted. readdir returns entries in filesystem
 * order, which differs between machines; since the result feeds both the cap
 * and the `sources=` list baked into SERVICE.md, an unsorted walk makes
 * `generate` on a laptop and `check` in CI disagree — reporting drift that
 * isn't there.
 */
export async function listSourceFiles(repoRoot: string, maxFiles = 500): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(path.resolve(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Files before directories, so the cap keeps shallow files rather than
    // whatever happened to sort first.
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.isDirectory()) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(toPosix(path.join(dir, entry.name)));
      }
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name));
    }
  }

  await walk(".");
  return results;
}
