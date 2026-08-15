import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor", "target"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".rs", ".php", ".kt", ".cs"]);

/** Repo-relative paths always use "/" so a hash generated on Windows matches one checked on Linux. */
export function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * The distinct directories a scanned file list lives in, sorted.
 *
 * Sections that scan a whole tree hash these alongside the files themselves.
 * The files cover content changes; only a directory listing covers a file
 * being *added*, which the recorded file list by definition cannot — it was
 * written before the new file existed.
 *
 * The repo root is excluded deliberately. Its listing contains SERVICE.md,
 * which `generate` writes *after* computing hashes, so tracking "." would make
 * every first run report itself as drifted.
 */
export function directoriesOf(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(toPosix(file));
    if (dir !== "." && dir !== "") dirs.add(dir);
  }
  return [...dirs].sort();
}

/**
 * Hard ceiling on how many source files the walk will even enumerate.
 *
 * Walking is cheap (readdir only, no file reads), so this sits far above the
 * scan limit. It exists so a wrong `--root` pointed at a huge tree degrades
 * instead of hanging.
 */
export const DISCOVERY_CEILING = 20_000;

export interface SourceScan {
  /** The files chosen for scanning, sorted. */
  files: string[];
  /** How many source files exist, up to DISCOVERY_CEILING. */
  totalFound: number;
  /** True when files.length < totalFound — some source went unread. */
  truncated: boolean;
  /** True when enumeration itself stopped early, so totalFound is a floor. */
  discoveryCapped: boolean;
}

/**
 * Enumerates source files, then selects up to `limit` of them spread across
 * directories.
 *
 * The spread is the point. Taking the first N in walk order meant one large
 * alphabetically-early directory could consume the entire budget: a 212-file
 * fixture with a limit of 200 produced an Architecture table claiming the whole
 * service lived in one directory, and a real TODO in the skipped directory was
 * reported as "none found". Round-robin means every directory contributes
 * before any directory contributes twice.
 *
 * Traversal is explicitly sorted. readdir returns entries in filesystem order,
 * which differs between machines; since the result feeds the `sources=` list
 * baked into SERVICE.md, an unsorted walk makes `generate` on a laptop and
 * `check` in CI disagree — reporting drift that isn't there.
 */
export async function scanSourceFiles(repoRoot: string, limit = 500): Promise<SourceScan> {
  const byDirectory = new Map<string, string[]>();
  let totalFound = 0;
  let discoveryCapped = false;

  async function walk(dir: string) {
    if (totalFound >= DISCOVERY_CEILING) {
      discoveryCapped = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(path.resolve(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isDirectory() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (totalFound >= DISCOVERY_CEILING) {
        discoveryCapped = true;
        return;
      }
      const key = toPosix(dir) === "." ? "." : toPosix(dir);
      const files = byDirectory.get(key) ?? [];
      files.push(toPosix(path.join(dir, entry.name)));
      byDirectory.set(key, files);
      totalFound++;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name));
    }
  }

  await walk(".");

  const directories = [...byDirectory.keys()].sort();
  const selected: string[] = [];
  for (let round = 0; selected.length < limit; round++) {
    let tookAny = false;
    for (const dir of directories) {
      if (selected.length >= limit) break;
      const file = byDirectory.get(dir)![round];
      if (file === undefined) continue;
      selected.push(file);
      tookAny = true;
    }
    if (!tookAny) break;
  }

  return {
    files: selected.sort(),
    totalFound,
    truncated: selected.length < totalFound,
    discoveryCapped,
  };
}

/** Convenience wrapper for callers that only want the selected paths. */
export async function listSourceFiles(repoRoot: string, maxFiles = 500): Promise<string[]> {
  return (await scanSourceFiles(repoRoot, maxFiles)).files;
}
