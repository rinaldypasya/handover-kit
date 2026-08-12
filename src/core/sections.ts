import { loadEnvVars, ENV_FILE_CANDIDATES } from "./parsers/env.js";
import { loadPackageInfo } from "./parsers/packageJson.js";
import { loadCodeowners, CODEOWNERS_CANDIDATES } from "./parsers/codeowners.js";
import { detectCi, findTodos, CI_FALLBACK_SOURCES } from "./parsers/ci.js";
import { listSourceFiles } from "./parsers/walk.js";
import { tryRead } from "./parsers/fsUtil.js";

export interface Section {
  id: string;
  title: string;
  /** Files this section's content is derived from — this is what gets hashed for drift detection. */
  sourceFiles: string[];
  render: () => Promise<string>;
}

/**
 * Upper bound on files scanned for TODO/FIXME. The same slice is both scanned
 * and hashed: if the two ever diverge, a TODO can appear in the doc from a file
 * whose changes nothing tracks, and the section never goes stale.
 */
export const TODO_SCAN_LIMIT = 200;

/** Cap on rows rendered into the Known Issues table. */
const TODO_RENDER_LIMIT = 50;

/**
 * Builds the list of sections for SERVICE.md. Each section knows exactly
 * which files it was derived from, so `handoverkit check` can recompute
 * its hash later and tell you precisely which section went stale and why.
 */
export async function buildSections(repoRoot: string): Promise<Section[]> {
  const pkg = await loadPackageInfo(repoRoot);
  const readme = await tryRead(repoRoot, "README.md");
  const envVars = await loadEnvVars(repoRoot);
  const ci = await detectCi(repoRoot);
  const owners = await loadCodeowners(repoRoot);
  const scannedFiles = (await listSourceFiles(repoRoot, TODO_SCAN_LIMIT)).slice(0, TODO_SCAN_LIMIT);
  const todos = await findTodos(repoRoot, scannedFiles);

  const sections: Section[] = [];

  sections.push({
    id: "overview",
    title: "Overview",
    sourceFiles: ["README.md", "package.json"],
    render: async () => {
      const name = pkg?.name ?? "(unnamed service)";
      const desc =
        pkg?.description ??
        extractFirstParagraph(readme) ??
        "_No description found in README.md or package.json._";
      return `**${name}**\n\n${desc}`;
    },
  });

  sections.push({
    id: "environment",
    title: "Environment & Config",
    sourceFiles: ENV_FILE_CANDIDATES,
    render: async () => {
      if (envVars.length === 0) {
        return "_No .env.example found. If this service needs environment variables, add one so this section can be generated._";
      }
      const rows = envVars.map(
        (v) =>
          `| \`${v.name}\` | ${v.defaultValue ? `\`${v.defaultValue}\`` : "_(no default)_"} | ${v.comment ?? ""} |`
      );
      return ["| Variable | Default | Notes |", "| --- | --- | --- |", ...rows].join("\n");
    },
  });

  sections.push({
    id: "local-setup",
    title: "Local Setup",
    sourceFiles: ["package.json"],
    render: async () => {
      if (!pkg || Object.keys(pkg.scripts).length === 0) {
        return "_No package.json scripts found. Document how to install, run, and test this service manually here._";
      }
      const rows = Object.entries(pkg.scripts).map(([name, cmd]) => `| \`npm run ${name}\` | \`${cmd}\` |`);
      const table = ["| Command | Runs |", "| --- | --- |", ...rows].join("\n");
      const deps =
        pkg.dependencies.length > 0
          ? `\n\nRuntime dependencies: ${pkg.dependencies.map((d) => `\`${d}\``).join(", ")}.`
          : "";
      return table + deps;
    },
  });

  sections.push({
    id: "deployment",
    title: "Deployment",
    sourceFiles: ci.files.length > 0 ? ci.files : CI_FALLBACK_SOURCES,
    render: async () => {
      if (ci.systems.length === 0) {
        return "_No CI config detected (.github/workflows or .gitlab-ci.yml). Document the deployment process manually here._";
      }
      // A repo can run more than one CI system; reporting only the first was
      // how this doc came to claim GitLab-only while GitHub Actions also ran.
      const lines = ci.systems.map(
        (s) => `- **${s.label}** — ${s.files.map((f) => `\`${f}\``).join(", ")}`
      );
      const lead =
        ci.systems.length === 1
          ? "Deployment is driven by:"
          : "Deployment is driven by more than one pipeline:";
      return [lead, "", ...lines].join("\n");
    },
  });

  sections.push({
    id: "known-issues",
    title: "Known Issues",
    sourceFiles: scannedFiles,
    render: async () => {
      if (todos.length === 0) {
        return `_No TODO/FIXME markers found in the ${scannedFiles.length} scanned source files._`;
      }
      const rows = todos.slice(0, TODO_RENDER_LIMIT).map((t) => `- \`${t.file}:${t.line}\` — ${t.text}`);
      const truncatedNote =
        todos.length > TODO_RENDER_LIMIT ? `\n\n_(${todos.length - TODO_RENDER_LIMIT} more not shown)_` : "";
      return rows.join("\n") + truncatedNote;
    },
  });

  sections.push({
    id: "ownership",
    title: "Ownership",
    sourceFiles: CODEOWNERS_CANDIDATES,
    render: async () => {
      if (owners.length === 0) {
        return "_No CODEOWNERS file found. Add one, or list who to contact for this service manually here._";
      }
      const rows = owners.map((o) => `| \`${o.pattern}\` | ${o.owners.join(", ")} |`);
      return ["| Path | Owners |", "| --- | --- |", ...rows].join("\n");
    },
  });

  return sections;
}

export function extractFirstParagraph(markdown?: string): string | undefined {
  if (!markdown) return undefined;
  const withoutHeadings = markdown.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
  const joined = withoutHeadings.join("\n").trim();
  const firstParagraph = joined.split(/\n\s*\n/)[0];
  return firstParagraph?.trim() || undefined;
}
