import { tryRead } from "./fsUtil.js";

export interface EnvVarInfo {
  name: string;
  defaultValue?: string;
  comment?: string;
}

/** Kept exported so sections.ts hashes exactly the files this parser reads. */
export const ENV_FILE_CANDIDATES = [".env.example", ".env.sample", ".env.template"];

/**
 * Parses a .env-style file into a list of variables. Keeps any comment
 * on the line directly above a variable as its description — a common
 * convention that's otherwise invisible to anyone not reading the raw file.
 */
export function parseEnvFile(contents: string): EnvVarInfo[] {
  const lines = contents.split(/\r?\n/);
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
    // `export FOO=bar` is valid in a .env meant to be sourced by a shell.
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) {
      vars.push({
        name: match[1],
        defaultValue: normalizeValue(match[2]),
        comment: pendingComment,
      });
    }
    pendingComment = undefined;
  }
  return vars;
}

/**
 * Strips surrounding quotes and trailing inline comments, so `FOO="bar" # note`
 * documents a default of `bar` rather than the raw line remainder. An unquoted
 * `#` only starts a comment when preceded by whitespace — otherwise values like
 * a URL fragment or `pass#word` would be truncated.
 */
function normalizeValue(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const quoted = value.match(/^(['"])([\s\S]*?)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2] || undefined;

  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  return withoutComment || undefined;
}

export async function loadEnvVars(repoRoot: string): Promise<EnvVarInfo[]> {
  for (const candidate of ENV_FILE_CANDIDATES) {
    const content = await tryRead(repoRoot, candidate);
    if (content !== undefined) return parseEnvFile(content);
  }
  return [];
}
