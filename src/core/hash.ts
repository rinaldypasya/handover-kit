import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Distinguishes "path absent" from "empty directory" and from any file content. */
const MISSING = "__MISSING__";
const DIRECTORY = "__DIR__";

/**
 * Separates directory entry names. NUL is the one byte a filename cannot
 * contain, so ["a b"] and ["a", "b"] can't collide the way a space would let
 * them. Built with fromCharCode rather than written as an escape so the byte
 * never appears literally in this source file.
 */
const ENTRY_SEPARATOR = String.fromCharCode(0);

/**
 * Computes a short, deterministic hash for a set of source paths.
 * This is what SERVICE.md sections store in their metadata comment,
 * and what `handoverkit check` recomputes to detect drift.
 *
 * A missing path is hashed as a fixed sentinel rather than skipped, so
 * that "the file used to exist and now doesn't" also shows up as drift
 * instead of silently matching.
 */
export async function hashFiles(repoRoot: string, relativePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  // Sort so hash is independent of the order sources were listed in.
  for (const rel of [...relativePaths].sort()) {
    hash.update(rel);
    hash.update(await fingerprint(path.resolve(repoRoot, rel)));
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * A file contributes its contents; a directory contributes its sorted entry
 * names.
 *
 * Hashing directories is what lets a section notice a file it never knew about.
 * Deployment records the CI paths it looked at, so a repo with no CI recorded
 * two absent paths — and adding `.github/workflows/deploy.yml` afterwards
 * changed none of them. The listing changes, so now it drifts.
 *
 * Only names, not contents: once a file exists it's listed as a source in its
 * own right, and the next generate picks it up.
 */
async function fingerprint(absolutePath: string): Promise<string | Buffer> {
  try {
    const info = await stat(absolutePath);
    if (!info.isDirectory()) {
      return await readFile(absolutePath);
    }
    const entries = await readdir(absolutePath);
    // Sorted: readdir returns filesystem order, which differs between machines
    // and would make a laptop and CI disagree about an unchanged directory.
    return DIRECTORY + entries.sort().join(ENTRY_SEPARATOR);
  } catch {
    return MISSING;
  }
}
