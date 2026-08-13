import path from "node:path";
import { builtinModules } from "node:module";
import { tryRead } from "./fsUtil.js";
import { toPosix } from "./walk.js";

export type SourceLanguage = "javascript" | "python" | "go";

const LANGUAGE_BY_EXTENSION = new Map<string, SourceLanguage>([
  [".ts", "javascript"],
  [".tsx", "javascript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
]);

const NODE_BUILTINS = new Set(builtinModules);

/**
 * Imports are matched with regexes rather than a parser, per language: the
 * point of this tool is a zero-dependency scan, and pulling in three ASTs to
 * draw a directory-level box diagram is not a trade worth making.
 *
 * The JavaScript patterns can't be line-anchored — imports appear mid-line and
 * across lines — so a specifier inside a string or comment counts as one. That
 * is why JS package names get cross-checked against package.json. The Python
 * and Go patterns *are* line-anchored, which rules out almost all of it.
 */
const JS_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
  /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // CommonJS require("x")
];

/** Extracts module specifiers as written, without interpreting them. */
export function parseImportSpecifiers(content: string, language: SourceLanguage = "javascript"): string[] {
  if (language === "python") return parsePythonImports(content);
  if (language === "go") return parseGoImports(content);

  const found = new Set<string>();
  for (const pattern of JS_PATTERNS) {
    for (const match of content.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Handles `import a.b`, `import a as x`, `import a, b`, and `from .pkg import x`. */
function parsePythonImports(content: string): string[] {
  const found = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    const fromImport = line.match(/^from[ \t]+([.\w]+)[ \t]+import[ \t]/);
    if (fromImport) {
      found.add(fromImport[1]);
      continue;
    }

    const plainImport = line.match(/^import[ \t]+(.+)$/);
    if (plainImport) {
      for (const clause of plainImport[1].split(",")) {
        // "a.b as alias" -> "a.b"
        const name = clause.trim().split(/[ \t]+/)[0];
        if (/^[\w.]+$/.test(name)) found.add(name);
      }
    }
  }
  return [...found].sort();
}

/** Handles single-line imports and parenthesised import blocks, with or without aliases. */
function parseGoImports(content: string): string[] {
  const found = new Set<string>();

  for (const block of content.matchAll(/^[ \t]*import[ \t]*\(([\s\S]*?)^[ \t]*\)/gm)) {
    for (const quoted of block[1].matchAll(/"([^"]+)"/g)) found.add(quoted[1]);
  }
  for (const single of content.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm)) {
    found.add(single[1]);
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
   * Third-party packages imported. JavaScript names are filtered to what
   * package.json declares; Go module paths are included because a first
   * segment containing a dot distinguishes them from the standard library
   * with certainty. Python is absent on purpose — see `pythonSeen`.
   */
  packages: string[];
  /** Languages actually parsed, sorted. */
  languages: SourceLanguage[];
  /**
   * True when Python files were parsed. Their external imports are omitted
   * because an import name doesn't reliably map to a distribution name
   * (`import yaml` comes from `PyYAML`), so listing them would guess.
   */
  pythonSeen: boolean;
  /** Scanned files skipped because their language isn't supported. */
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
  // Regexes can't tell a JS import from a string literal that looks like one —
  // this repo's own test fixtures contain lines such as `import x from
  // "lodash"`, which had SERVICE.md claiming a lodash dependency. Intersecting
  // with what package.json declares removes that whole class of lie.
  // The trade: a package imported but never declared won't be listed either.
  const declared = declaredPackages ? new Set(declaredPackages) : undefined;
  const goModule = await readGoModule(repoRoot);

  const fileCounts = new Map<string, number>();
  for (const file of files) {
    const dir = dirOf(file);
    fileCounts.set(dir, (fileCounts.get(dir) ?? 0) + 1);
  }

  const edges = new Map<string, Set<string>>();
  const packages = new Set<string>();
  const languages = new Set<SourceLanguage>();
  let unparsedCount = 0;

  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION.get(path.extname(file));
    if (!language) {
      unparsedCount++;
      continue;
    }
    const content = await tryRead(repoRoot, file);
    if (content === undefined) continue;
    languages.add(language);

    const from = dirOf(file);
    for (const specifier of parseImportSpecifiers(content, language)) {
      const resolved = resolve(specifier, from, language, fileCounts, goModule);
      if (resolved.kind === "internal") {
        if (resolved.dir === from) continue; // cohesion, not coupling
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from)!.add(resolved.dir);
      } else if (resolved.kind === "external") {
        if (declared === undefined || language !== "javascript" || declared.has(resolved.name)) {
          packages.add(resolved.name);
        }
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

  return {
    modules,
    packages: [...packages].sort((a, b) => a.localeCompare(b)),
    languages: [...languages].sort(),
    pythonSeen: languages.has("python"),
    unparsedCount,
  };
}

type Resolution =
  | { kind: "internal"; dir: string }
  | { kind: "external"; name: string }
  | { kind: "ignored" };

function resolve(
  specifier: string,
  from: string,
  language: SourceLanguage,
  knownDirs: Map<string, number>,
  goModule?: string
): Resolution {
  if (language === "javascript") {
    if (specifier.startsWith(".")) {
      return internalOrIgnored(path.posix.join(from, specifier), knownDirs);
    }
    const name = jsPackageName(specifier);
    return name ? { kind: "external", name } : { kind: "ignored" };
  }

  if (language === "python") {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    if (dots > 0) {
      // "..pkg.mod" from app/core -> app/pkg/mod; a single dot means this package.
      const upwards = "../".repeat(dots - 1);
      const tail = specifier.slice(dots).split(".").join("/");
      return internalOrIgnored(path.posix.join(from, upwards, tail), knownDirs);
    }
    // Absolute imports commonly name in-repo packages when run from the root.
    const asPath = specifier.split(".").join("/");
    const internal = internalOrIgnored(asPath, knownDirs);
    // Externals are dropped: an import name doesn't map reliably to a package.
    return internal.kind === "internal" ? internal : { kind: "ignored" };
  }

  // Go: import paths are absolute. In-repo ones start with the module path.
  if (goModule && (specifier === goModule || specifier.startsWith(`${goModule}/`))) {
    const withinModule = specifier.slice(goModule.length).replace(/^\//, "");
    return withinModule === "" ? { kind: "ignored" } : internalOrIgnored(withinModule, knownDirs);
  }
  // A dot in the first segment means a hosted path; the standard library never
  // has one. That's a rule, not a heuristic, so Go externals are safe to list.
  const firstSegment = specifier.split("/")[0];
  return firstSegment.includes(".") ? { kind: "external", name: specifier } : { kind: "ignored" };
}

/**
 * A specifier may name a directory or a module file inside one. Try the path
 * itself, then its parent; anything else is outside the scanned set and is
 * usually an unresolvable or capped-out path rather than a real edge.
 */
function internalOrIgnored(candidate: string, knownDirs: Map<string, number>): Resolution {
  const normalised = toPosix(path.posix.normalize(candidate)).replace(/\/$/, "");
  if (knownDirs.has(normalised)) return { kind: "internal", dir: normalised };
  const parent = path.posix.dirname(normalised);
  if (knownDirs.has(parent)) return { kind: "internal", dir: parent };
  return { kind: "ignored" };
}

async function readGoModule(repoRoot: string): Promise<string | undefined> {
  const goMod = await tryRead(repoRoot, "go.mod");
  return goMod?.match(/^[ \t]*module[ \t]+(\S+)/m)?.[1];
}

function dirOf(relativePath: string): string {
  return path.posix.dirname(toPosix(relativePath));
}

/** "@scope/pkg/sub" -> "@scope/pkg", "lodash/merge" -> "lodash", builtins -> undefined. */
function jsPackageName(specifier: string): string | undefined {
  if (specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!name || NODE_BUILTINS.has(name)) return undefined;
  return name;
}
