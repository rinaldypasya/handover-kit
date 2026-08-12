import { loadEnvVars } from "./parsers/env.js";
import { loadPackageInfo } from "./parsers/packageJson.js";
import { loadCodeowners } from "./parsers/codeowners.js";
import { detectCi, findTodos } from "./parsers/ci.js";
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
  const sourceFiles = await listSourceFiles(repoRoot);
  const todos = await findTodos(repoRoot, sourceFiles);

  const sections: Section[] = [];

  sections.push({
    id: "overview",
    title: "Overview",
    sourceFiles: ["README.md", "package.json"],
    render: async () => {
      const name = pkg?.name ?? "(unnamed service)";
      const desc = pkg?.description ?? extractFirstParagraph(readme) ?? "_No description found in README.md or package.json._";
      return `**${name}**\n\n${desc}`;
    },
  });

  sections.push({
    id: "environment",
    title: "Environment & Config",
    sourceFiles: [".env.example", ".env.sample", ".env.template"],
    render: async () => {
      if (envVars.length === 0) {
        return "_No .env.example found. If this service needs environment variables, add one so this section can be generated._";
      }
      const rows = envVars.map((v) => `| \`${v.name}\` | ${v.defaultValue ? `\`${v.defaultValue}\`` : "_(no default)_"} | ${v.comment ?? ""} |`);
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
      return ["| Command | Runs |", "| --- | --- |", ...rows].join("\n");
    },
  });

  sections.push({
    id: "deployment",
    title: "Deployment",
    sourceFiles: ci.files.length > 0 ? ci.files : [".gitlab-ci.yml"],
    render: async () => {
      if (ci.kind === "none") {
        return "_No CI config detected (.github/workflows or .gitlab-ci.yml). Document the deployment process manually here._";
      }
      const label = ci.kind === "github-actions" ? "GitHub Actions" : "GitLab CI";
      return `Deployment is driven by **${label}**. Pipeline definition: ${ci.files.map((f) => `\`${f}\``).join(", ")}.`;
    },
  });

  sections.push({
    id: "known-issues",
    title: "Known Issues",
    sourceFiles: sourceFiles.slice(0, 200), // cap to keep hash stable-ish and fast; see listSourceFiles cap
    render: async () => {
      if (todos.length === 0) {
        return "_No TODO/FIXME markers found in scanned source files._";
      }
      const rows = todos.slice(0, 50).map((t) => `- \`${t.file}:${t.line}\` — ${t.text}`);
      const truncatedNote = todos.length > 50 ? `\n\n_(${todos.length - 50} more not shown)_` : "";
      return rows.join("\n") + truncatedNote;
    },
  });

  sections.push({
    id: "ownership",
    title: "Ownership",
    sourceFiles: ["CODEOWNERS", ".github/CODEOWNERS"],
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

function extractFirstParagraph(markdown?: string): string | undefined {
  if (!markdown) return undefined;
  const withoutHeadings = markdown
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"));
  const joined = withoutHeadings.join("\n").trim();
  const firstParagraph = joined.split(/\n\s*\n/)[0];
  return firstParagraph?.trim() || undefined;
}
