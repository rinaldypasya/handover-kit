import { readFile } from "node:fs/promises";
import path from "node:path";

/** Reads a file relative to repoRoot, returning undefined instead of throwing if it's missing. */
export async function tryRead(repoRoot: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(repoRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

export async function firstExisting(repoRoot: string, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) {
    const content = await tryRead(repoRoot, c);
    if (content !== undefined) return c;
  }
  return undefined;
}
