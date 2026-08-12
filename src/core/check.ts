import { hashFiles } from "./hash.js";

export interface DriftResult {
  id: string;
  title: string;
  sources: string[];
  storedHash: string;
  currentHash: string;
  stale: boolean;
}

const METADATA_RE = /^##\s+(.+)\n<!--\s*handoverkit:id=(\S+)\s+hash=(\S+)\s+sources=([^\s]*)\s*-->/gm;

/**
 * Parses an existing SERVICE.md, recomputes each section's hash from its
 * declared source files, and reports which sections drifted. This is the
 * whole mechanism behind the PR/MR bot comment: no LLM, no guessing —
 * just "these files changed, this doc section didn't."
 */
export async function checkServiceMd(repoRoot: string, serviceMdContent: string): Promise<DriftResult[]> {
  const results: DriftResult[] = [];
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
  const stale = results.filter((r) => r.stale);
  if (stale.length === 0) {
    return "✅ handover-kit: SERVICE.md is up to date with its source files.";
  }
  const lines = [
    "⚠️ **handover-kit**: some SERVICE.md sections may be out of date.",
    "",
    "The following source files changed but their documented section wasn't updated:",
    "",
  ];
  for (const r of stale) {
    lines.push(`- **${r.title}** — depends on ${r.sources.map((s) => `\`${s}\``).join(", ")}`);
  }
  lines.push(
    "",
    "If the docs are still accurate as-is, re-run `handoverkit generate` and commit the updated SERVICE.md — that re-baselines the stored hash for these sections."
  );
  return lines.join("\n");
}
