import { tryRead } from "./fsUtil.js";

export interface EnvVarInfo {
  name: string;
  defaultValue?: string;
  comment?: string;
}

/**
 * Parses a .env-style file into a list of variables. Keeps any comment
 * on the line directly above a variable as its description — a common
 * convention that's otherwise invisible to anyone not reading the raw file.
 */
export function parseEnvFile(contents: string): EnvVarInfo[] {
  const lines = contents.split("\n");
  const vars: EnvVarInfo[] = [];
  let pendingComment: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      pendingComment = undefined;
      continue;
    }
    if (line.startsWith("#")) {
      pendingComment = line.replace(/^#+\s*/, "");
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) {
      vars.push({
        name: match[1],
        defaultValue: match[2] || undefined,
        comment: pendingComment,
      });
    }
    pendingComment = undefined;
  }
  return vars;
}

export async function loadEnvVars(repoRoot: string): Promise<EnvVarInfo[]> {
  const candidates = [".env.example", ".env.sample", ".env.template"];
  for (const c of candidates) {
    const content = await tryRead(repoRoot, c);
    if (content !== undefined) return parseEnvFile(content);
  }
  return [];
}
