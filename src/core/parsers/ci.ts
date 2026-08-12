import { readdir } from "node:fs/promises";
import path from "node:path";
import { tryRead } from "./fsUtil.js";

export interface CiInfo {
  kind: "github-actions" | "gitlab-ci" | "none";
  files: string[];
}

export async function detectCi(repoRoot: string): Promise<CiInfo> {
  const gitlabCi = await tryRead(repoRoot, ".gitlab-ci.yml");
  if (gitlabCi !== undefined) {
    return { kind: "gitlab-ci", files: [".gitlab-ci.yml"] };
  }

  try {
    const workflowsDir = path.join(repoRoot, ".github", "workflows");
    const entries = await readdir(workflowsDir);
    const ymlFiles = entries.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    if (ymlFiles.length > 0) {
      return {
        kind: "github-actions",
        files: ymlFiles.map((f) => path.join(".github", "workflows", f)),
      };
    }
  } catch {
    // no .github/workflows directory, fall through
  }

  return { kind: "none", files: [] };
}

/** Finds TODO/FIXME markers in a small set of source files (best-effort, not a full repo scan). */
export async function findTodos(repoRoot: string, files: string[]): Promise<{ file: string; line: number; text: string }[]> {
  const results: { file: string; line: number; text: string }[] = [];
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
