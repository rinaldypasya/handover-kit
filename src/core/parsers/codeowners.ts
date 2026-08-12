import { tryRead } from "./fsUtil.js";

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

export async function loadCodeowners(repoRoot: string): Promise<CodeownersEntry[]> {
  const candidates = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
  for (const c of candidates) {
    const content = await tryRead(repoRoot, c);
    if (content === undefined) continue;
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const [pattern, ...owners] = l.split(/\s+/);
        return { pattern, owners };
      });
  }
  return [];
}
