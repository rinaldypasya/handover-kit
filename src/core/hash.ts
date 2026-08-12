import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Computes a short, deterministic hash for a set of source files.
 * This is what SERVICE.md sections store in their metadata comment,
 * and what `handoverkit check` recomputes to detect drift.
 *
 * A missing file is hashed as a fixed sentinel rather than skipped, so
 * that "the file used to exist and now doesn't" also shows up as drift
 * instead of silently matching.
 */
export async function hashFiles(repoRoot: string, relativePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  // Sort so hash is independent of the order sources were listed in.
  for (const rel of [...relativePaths].sort()) {
    const abs = path.resolve(repoRoot, rel);
    hash.update(rel);
    try {
      const contents = await readFile(abs);
      hash.update(contents);
    } catch {
      hash.update("__MISSING__");
    }
  }
  return hash.digest("hex").slice(0, 12);
}
