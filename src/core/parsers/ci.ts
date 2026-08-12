import { readdir } from "node:fs/promises";
import path from "node:path";
import { tryRead } from "./fsUtil.js";
import { toPosix } from "./walk.js";

export type CiKind = "github-actions" | "gitlab-ci";

export interface CiSystem {
  kind: CiKind;
  label: string;
  files: string[];
}

export interface CiInfo {
  /** Every CI system found, not just the first — repos commonly run both. */
  systems: CiSystem[];
  /** Flattened, sorted list of every detected pipeline file. */
  files: string[];
}

/**
 * Always hashed by the Deployment section, whether or not anything was found.
 *
 * `.github/workflows` is the directory, not a file: hashFiles fingerprints a
 * directory by its entry names, so adding the repo's first workflow — or a
 * second one — changes the hash. Recording only the files that happened to
 * exist at generate time is what let new pipelines slip in undetected.
 */
export const CI_SOURCE_ROOTS = [".gitlab-ci.yml", ".github/workflows"];

export async function detectCi(repoRoot: string): Promise<CiInfo> {
  const systems: CiSystem[] = [];

  const workflows = await listWorkflowFiles(repoRoot);
  if (workflows.length > 0) {
    systems.push({ kind: "github-actions", label: "GitHub Actions", files: workflows });
  }

  const gitlabCi = await tryRead(repoRoot, ".gitlab-ci.yml");
  if (gitlabCi !== undefined) {
    systems.push({ kind: "gitlab-ci", label: "GitLab CI", files: [".gitlab-ci.yml"] });
  }

  const files = systems.flatMap((s) => s.files).sort();
  return { systems, files };
}

async function listWorkflowFiles(repoRoot: string): Promise<string[]> {
  try {
    const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
    const entries = await readdir(workflowsDir);
    return entries
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort()
      .map((f) => toPosix(path.join(".github", "workflows", f)));
  } catch {
    return [];
  }
}

export interface TodoMarker {
  file: string;
  line: number;
  text: string;
}

/** Finds TODO/FIXME markers in a small set of source files (best-effort, not a full repo scan). */
export async function findTodos(repoRoot: string, files: string[]): Promise<TodoMarker[]> {
  const results: TodoMarker[] = [];
  for (const file of files) {
    const content = await tryRead(repoRoot, file);
    if (!content) continue;
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      // Require an actual comment marker immediately before the keyword
      // (only whitespace in between). Without this, any prose that
      // mentions "TODO/FIXME" descriptively — including this file's own
      // docstrings, or a regex literal like /(TODO|FIXME)/ in source —
      // gets misreported as a real marker.
      const match = line.match(/(?:\/\/|#|\*)\s*(TODO|FIXME)\b[:\s]*(.*)/);
      if (match) {
        results.push({ file, line: idx + 1, text: match[2].trim() || match[1] });
      }
    });
  }
  return results;
}
