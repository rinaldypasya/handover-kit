import { hashFiles } from "./hash.js";
import { REPORT_MARKER } from "../marker.js";

export interface DriftResult {
  id: string;
  title: string;
  sources: string[];
  storedHash: string;
  currentHash: string;
  stale: boolean;
}

// `\r?\n` so a SERVICE.md checked out with CRLF line endings (Windows, or
// git's autocrlf) still parses — otherwise every section silently vanishes
// from the report and `check` reports "up to date" on a file it never read.
const METADATA_RE =
  /^##[ \t]+(.+?)[ \t]*\r?\n<!--\s*handoverkit:id=(\S+)\s+hash=(\S+)\s+sources=(\S*)\s*-->/gm;

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
    const [, title, id, storedHash, sourcesRaw] = match;
    const sources = sourcesRaw ? sourcesRaw.split(",").filter(Boolean) : [];
    const currentHash = await hashFiles(repoRoot, sources);
    results.push({
      id,
      title: title.trim(),
      sources,
      storedHash,
      currentHash,
      stale: storedHash !== currentHash,
    });
  }

  return results;
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
    lines.push(`- **${r.title}** — depends on ${summarizeSources(r.sources)}`);
  }
  lines.push(
    "",
    "If the docs are still accurate as-is, re-run `handoverkit generate` and commit the updated SERVICE.md — that re-baselines the stored hash for these sections."
  );
  return lines.join("\n");
}

/**
 * Sections like Known Issues can depend on hundreds of files; listing them all
 * turns the PR comment into a wall of paths. Show a few, count the rest.
 */
function summarizeSources(sources: string[], limit = 5): string {
  if (sources.length === 0) return "_(no source files recorded)_";
  const shown = sources.slice(0, limit).map((s) => `\`${s}\``).join(", ");
  const rest = sources.length - limit;
  return rest > 0 ? `${shown} _(+${rest} more)_` : shown;
}
