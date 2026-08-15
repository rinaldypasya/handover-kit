import { tryRead, pathExists } from "./fsUtil.js";

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

/** Characters that make a pattern a glob rather than a path we can simply stat. */
const GLOB_CHARS = /[*?[\]!]/;

export function isLiteralPattern(pattern: string): boolean {
  return !GLOB_CHARS.test(pattern);
}

/** "/src/api/" and "src/api" both name the same place; normalise to "src/api". */
export function patternToPath(pattern: string): string {
  return pattern.replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface OwnershipAudit {
  /** Literal paths named in CODEOWNERS that aren't on disk. */
  missing: string[];
  /** Scanned directories no literal pattern covers. */
  unowned: string[];
  /** Patterns left unchecked because matching them properly needs a glob engine. */
  unchecked: string[];
}

/**
 * Checks a CODEOWNERS file against the repo it claims to describe.
 *
 * The section used to render whatever the file said, unconditionally: a
 * fixture naming a directory that had been deleted rendered as a legitimate
 * row, and a directory full of code with no owner at all was simply absent,
 * leaving a table that looked like full coverage.
 *
 * Glob patterns are reported as unchecked rather than guessed at. Matching
 * gitignore-style globs properly needs a real engine, and a wrong answer here
 * would either accuse a valid entry or hide a real gap.
 */
export async function auditOwnership(
  repoRoot: string,
  entries: CodeownersEntry[],
  scannedDirectories: string[]
): Promise<OwnershipAudit> {
  const literals: string[] = [];
  const unchecked: string[] = [];
  for (const entry of entries) {
    if (isLiteralPattern(entry.pattern)) literals.push(patternToPath(entry.pattern));
    else unchecked.push(entry.pattern);
  }

  const missing: string[] = [];
  for (const literal of literals) {
    if (!(await pathExists(repoRoot, literal))) missing.push(literal);
  }

  const covers = (directory: string) =>
    literals.some((literal) => directory === literal || directory.startsWith(`${literal}/`));
  const unowned = scannedDirectories.filter((directory) => !covers(directory));

  return {
    missing: [...new Set(missing)].sort(),
    unowned: [...new Set(unowned)].sort(),
    unchecked: [...new Set(unchecked)].sort(),
  };
}
