import { readdir } from "node:fs/promises";
import path from "node:path";
import { hashFiles, fingerprintSource } from "./hash.js";
import { REPORT_MARKER } from "../marker.js";
import type { KnownIssue } from "./sections.js";

export interface SourceChange {
  path: string;
  /** `added` is attributed to the directory that now contains the file. */
  kind: "changed" | "removed" | "added";
}

export interface DriftResult {
  id: string;
  title: string;
  sources: string[];
  storedHash: string;
  currentHash: string;
  stale: boolean;
  /**
   * Which sources moved. Empty when nothing did; undefined when the document
   * predates per-source digests and the question can't be answered.
   */
  changes?: SourceChange[];
}

// `\r?\n` so a SERVICE.md checked out with CRLF line endings (Windows, or
// git's autocrlf) still parses — otherwise every section silently vanishes
// from the report and `check` reports "up to date" on a file it never read.
const METADATA_RE =
  /^##[ \t]+(.+?)[ \t]*\r?\n<!--\s*handoverkit:id=(\S+)\s+hash=(\S+)\s+sources=(\S*?)(?:\s+digests=(\S*))?\s*-->/gm;

/**
 * Parses an existing SERVICE.md, recomputes each section's hash from its
 * declared source files, and reports which sections drifted. This is the
 * whole mechanism behind the PR/MR bot comment: no LLM, no guessing —
 * just "these files changed, this doc section didn't."
 */
export async function checkServiceMd(repoRoot: string, serviceMdContent: string): Promise<DriftResult[]> {
  const results: DriftResult[] = [];
  // matchAll on a shared /g regex is safe (it clones internally), but lastIndex
  // on the shared literal is not — reset so repeated calls behave identically.
  METADATA_RE.lastIndex = 0;
  const matches = serviceMdContent.matchAll(METADATA_RE);

  for (const match of matches) {
    const [, title, id, storedHash, sourcesRaw, digestsRaw] = match;
    const sources = sourcesRaw ? sourcesRaw.split(",").filter(Boolean) : [];
    const storedDigests = digestsRaw === undefined ? undefined : digestsRaw.split(",").filter(Boolean);
    const currentHash = await hashFiles(repoRoot, sources);
    const stale = storedHash !== currentHash;

    results.push({
      id,
      title: title.trim(),
      sources,
      storedHash,
      currentHash,
      stale,
      changes: stale ? await locateChanges(repoRoot, sources, storedDigests) : undefined,
    });
  }

  return results;
}

/**
 * Attributes a section's drift to individual sources.
 *
 * Returns undefined when the document carries no digests — an older SERVICE.md,
 * or one whose digest count no longer lines up with its source list. Guessing
 * from a mismatched pair would name innocent files, which is the failure this
 * exists to fix.
 */
async function locateChanges(
  repoRoot: string,
  sources: string[],
  storedDigests: string[] | undefined
): Promise<SourceChange[] | undefined> {
  if (!storedDigests || storedDigests.length !== sources.length) return undefined;

  const changes: SourceChange[] = [];
  const tracked = new Set(sources);

  for (const [index, source] of sources.entries()) {
    const current = await fingerprintSource(repoRoot, source);
    if (current.digest === storedDigests[index]) continue;

    if (current.kind === "missing") {
      changes.push({ path: source, kind: "removed" });
      continue;
    }
    if (current.kind === "directory") {
      // A directory's digest is its listing, so it moved because an entry
      // appeared or vanished. Naming the directory is less useful than naming
      // the file, and the file list already tells us which entries are known.
      changes.push(...(await newEntriesIn(repoRoot, source, tracked)));
      continue;
    }
    changes.push({ path: source, kind: "changed" });
  }

  return changes;
}

/** Files sitting in a tracked directory that the recorded source list doesn't know about. */
async function newEntriesIn(repoRoot: string, directory: string, tracked: Set<string>): Promise<SourceChange[]> {
  let entries;
  try {
    entries = await readdir(path.resolve(repoRoot, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`)
    .filter((candidate) => !tracked.has(candidate))
    .sort()
    .map((candidate) => ({ path: candidate, kind: "added" as const }));
}

export function formatDriftReport(results: DriftResult[]): string {
  if (results.length === 0) {
    return [
      REPORT_MARKER,
      "⚠️ **handover-kit**: no tracked sections found in SERVICE.md.",
      "",
      "Either the file has no `handoverkit:` metadata comments, or they were removed. Run `handoverkit generate` to (re)create it.",
    ].join("\n");
  }

  const stale = results.filter((r) => r.stale);
  if (stale.length === 0) {
    return `${REPORT_MARKER}\n✅ handover-kit: SERVICE.md is up to date with its source files (${results.length} sections checked).`;
  }

  const lines = [
    REPORT_MARKER,
    "⚠️ **handover-kit**: some SERVICE.md sections may be out of date.",
    "",
    "The following source files changed but their documented section wasn't updated:",
    "",
  ];
  for (const r of stale) {
    lines.push(`- **${r.title}** — ${describeChanges(r)}`);
    lines.push(...detailLines(r));
  }
  lines.push(
    "",
    "If the docs are still accurate as-is, re-run `handoverkit generate` and commit the updated SERVICE.md — that re-baselines the stored hash for these sections."
  );
  return lines.join("\n");
}

const ISSUES_MARKER_RE = /<!--\s*handoverkit:issues=([^>]*?)\s*-->/;

/**
 * The ticket URLs the document was generated against, or undefined if it was
 * generated without `--with-issues` and so never claimed a ticket list at all.
 */
export function extractDocumentedIssueUrls(serviceMd: string): string[] | undefined {
  const match = serviceMd.match(ISSUES_MARKER_RE);
  if (!match) return undefined;
  return match[1].split(/\s+/).filter(Boolean).sort();
}

export interface IssueComparison {
  /** Documented, but not open in the tracker any more. */
  closed: string[];
  /** Open in the tracker, but not in the document. */
  missing: KnownIssue[];
}

export function compareDocumentedIssues(documented: string[], open: KnownIssue[]): IssueComparison {
  const openUrls = new Set(open.map((i) => i.url));
  const documentedUrls = new Set(documented);
  return {
    closed: documented.filter((url) => !openUrls.has(url)).sort(),
    missing: open.filter((i) => !documentedUrls.has(i.url)).sort((a, b) => a.url.localeCompare(b.url)),
  };
}

/**
 * Advisory only, and deliberately so.
 *
 * A ticket list is a snapshot of a remote system. Letting it drive the drift
 * verdict would make `check` non-deterministic and fail builds on commits that
 * changed nothing — the reason tracker issues stay out of the section hash.
 * This note tells you the snapshot aged; it does not touch the exit code.
 */
export function formatIssueNote(comparison: IssueComparison): string {
  const { closed, missing } = comparison;
  if (closed.length === 0 && missing.length === 0) {
    return "ℹ️ handover-kit: the documented ticket list still matches the tracker.";
  }

  const lines = ["ℹ️ **handover-kit**: the documented ticket list has aged (advisory — this does not fail the check).", ""];
  if (closed.length > 0) {
    lines.push(`${closed.length} ticket${closed.length === 1 ? "" : "s"} listed in SERVICE.md ${closed.length === 1 ? "is" : "are"} no longer open:`, "");
    lines.push(...closed.slice(0, 10).map((url) => `- ${url}`));
    if (closed.length > 10) lines.push(`- _(${closed.length - 10} more)_`);
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push(`${missing.length} open ticket${missing.length === 1 ? "" : "s"} ${missing.length === 1 ? "isn't" : "aren't"} in SERVICE.md:`, "");
    lines.push(...missing.slice(0, 10).map((i) => `- [${i.title.replace(/([[\]])/g, "\\$1")}](${i.url})`));
    if (missing.length > 10) lines.push(`- _(${missing.length - 10} more)_`);
    lines.push("");
  }
  lines.push("Re-run `handoverkit generate --with-issues` and commit to refresh it.");
  return lines.join("\n");
}

const KIND_LABELS: Record<SourceChange["kind"], string> = {
  changed: "changed",
  added: "added",
  removed: "removed",
};

/** A one-line count, e.g. "1 file changed, 1 added, 1 removed". */
function describeChanges(result: DriftResult): string {
  if (result.changes === undefined) {
    // Pre-digest document: say what we can, and don't imply the listed files
    // are the ones that moved.
    return `depends on ${summarizeSources(result.sources)} — regenerate to record which file changed`;
  }
  if (result.changes.length === 0) {
    return "its sources moved, but no individual source could be attributed";
  }
  const counts = (["changed", "added", "removed"] as const)
    .map((kind) => ({ kind, n: result.changes!.filter((c) => c.kind === kind).length }))
    .filter(({ n }) => n > 0)
    .map(({ kind, n }, index) => (index === 0 ? `${n} file${n === 1 ? "" : "s"} ${KIND_LABELS[kind]}` : `${n} ${KIND_LABELS[kind]}`));
  return counts.join(", ");
}

/** The paths themselves, indented under the section, capped per category. */
function detailLines(result: DriftResult, limit = 5): string[] {
  if (!result.changes || result.changes.length === 0) return [];
  const lines: string[] = [];
  for (const kind of ["changed", "added", "removed"] as const) {
    const matching = result.changes.filter((c) => c.kind === kind);
    if (matching.length === 0) continue;
    const shown = matching.slice(0, limit).map((c) => `\`${c.path}\``).join(", ");
    const rest = matching.length - limit;
    lines.push(`  - ${KIND_LABELS[kind]}: ${shown}${rest > 0 ? ` _(+${rest} more)_` : ""}`);
  }
  return lines;
}

/**
 * Fallback for documents with no recorded digests. Listing the first few
 * sources is only ever a hint about what the section covers — it is not a
 * claim that those files moved.
 */
function summarizeSources(sources: string[], limit = 5): string {
  if (sources.length === 0) return "_(no source files recorded)_";
  const shown = sources.slice(0, limit).map((s) => `\`${s}\``).join(", ");
  const rest = sources.length - limit;
  return rest > 0 ? `${shown} _(+${rest} more)_` : shown;
}
