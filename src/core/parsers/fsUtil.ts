import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Reads a file relative to repoRoot, returning undefined instead of throwing
 * if it's missing (or is a directory). `resolve` rather than `join` so an
 * absolute path passed through by the CLI still lands where the caller meant.
 */
export async function tryRead(repoRoot: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.resolve(repoRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

/** True for files and directories alike — tryRead can't tell "absent" from "is a directory". */
export async function pathExists(repoRoot: string, relativePath: string): Promise<boolean> {
  try {
    await stat(path.resolve(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function firstExisting(repoRoot: string, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) {
    const content = await tryRead(repoRoot, c);
    if (content !== undefined) return c;
  }
  return undefined;
}
