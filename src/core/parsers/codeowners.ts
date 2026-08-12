import { tryRead } from "./fsUtil.js";

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

/**
 * Every location git itself honours. Exported so sections.ts hashes the same
 * set this parser reads — otherwise a repo whose CODEOWNERS lives in docs/
 * would render owners in SERVICE.md while drift on that file went undetected.
 */
export const CODEOWNERS_CANDIDATES = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export function parseCodeowners(contents: string): CodeownersEntry[] {
  return contents
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners };
    })
    .filter((e) => e.owners.length > 0);
}

export async function loadCodeowners(repoRoot: string): Promise<CodeownersEntry[]> {
  for (const candidate of CODEOWNERS_CANDIDATES) {
    const content = await tryRead(repoRoot, candidate);
    if (content === undefined) continue;
    return parseCodeowners(content);
  }
  return [];
}
