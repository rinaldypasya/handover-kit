import path from "node:path";
import { builtinModules } from "node:module";
import { tryRead } from "./fsUtil.js";
import { toPosix } from "./walk.js";

/** Only these get parsed for imports; other languages are counted, not read. */
const JS_LIKE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const BUILTINS = new Set(builtinModules);

/**
 * Module specifiers are matched with regexes rather than a parser: the whole
 * point of this tool is a zero-dependency scan, and pulling in a TypeScript AST
 * to draw a directory-level box diagram is not a trade worth making.
 *
 * The cost is honest — a specifier mentioned inside a comment or string counts
 * as an import. At directory granularity that almost never changes the picture.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
  /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // CommonJS require("x")
];

export function parseImportSpecifiers(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

export interface ModuleNode {
  /** Repo-relative directory, "." for the repo root. */
  dir: string;
  fileCount: number;
  /** Other scanned directories this one imports from, sorted. */
  dependsOn: string[];
}

export interface ModuleGraph {
  modules: ModuleNode[];
  /**
   * Third-party packages imported, excluding Node builtins. Filtered to what
   * package.json declares when the caller supplies that list.
   */
  packages: string[];
  /** Scanned files skipped because they aren't a JS/TS family extension. */
  unparsedCount: number;
}

/**
 * Groups scanned files by directory and derives which directories import from
 * which. Directory granularity rather than file: a per-file graph of a real
 * service is unreadable, and the question a handover needs answered is "what
 * talks to what", not "which line imports which symbol".
 */
export async function buildModuleGraph(
  repoRoot: string,
  files: string[],
  declaredPackages?: string[]
): Promise<ModuleGraph> {
  // Regexes can't tell an import from a string literal that looks like one —
  // this repo's own test fixtures contain lines such as `import x from
  // "lodash"`, which had SERVICE.md claiming a lodash dependency. Intersecting
  // with what package.json actually declares removes that whole class of lie.
  // The trade: a package imported but never declared won't be listed either.
  const declared = declaredPackages ? new Set(declaredPackages) : undefined;
  const fileCounts = new Map<string, number>();
  for (const file of files) {
    const dir = dirOf(file);
    fileCounts.set(dir, (fileCounts.get(dir) ?? 0) + 1);
  }

  const edges = new Map<string, Set<string>>();
  const packages = new Set<string>();
  let unparsedCount = 0;

  for (const file of files) {
    if (!JS_LIKE.has(path.extname(file))) {
      unparsedCount++;
      continue;
    }
    const content = await tryRead(repoRoot, file);
    if (content === undefined) continue;

    const from = dirOf(file);
    for (const specifier of parseImportSpecifiers(content)) {
      if (specifier.startsWith(".")) {
        const target = dirOf(toPosix(path.posix.join(from, specifier)));
        // Self-edges say nothing, and a target outside the scanned set is
        // usually an unresolvable or capped-out path rather than a real edge.
        if (target === from || !fileCounts.has(target)) continue;
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from)!.add(target);
      } else {
        const pkg = packageName(specifier);
        if (pkg && (declared === undefined || declared.has(pkg))) packages.add(pkg);
      }
    }
  }

  const modules = [...fileCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, fileCount]) => ({
      dir,
      fileCount,
      dependsOn: [...(edges.get(dir) ?? [])].sort((a, b) => a.localeCompare(b)),
    }));

  return { modules, packages: [...packages].sort((a, b) => a.localeCompare(b)), unparsedCount };
}

function dirOf(relativePath: string): string {
  return path.posix.dirname(toPosix(relativePath));
}

/** "@scope/pkg/sub" -> "@scope/pkg", "lodash/merge" -> "lodash", builtins -> undefined. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!name || BUILTINS.has(name)) return undefined;
  return name;
}
