import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java"]);

/**
 * Lightweight recursive source file listing, capped so it stays fast on
 * large repos without pulling in a glob dependency. Good enough for the
 * "scan for TODO/FIXME" use case — not meant to replace `git ls-files`.
 */
export async function listSourceFiles(repoRoot: string, maxFiles = 500): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(".");
  return results;
}
