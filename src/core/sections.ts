import { loadEnvVars, ENV_FILE_CANDIDATES } from "./parsers/env.js";
import { loadPackageInfo } from "./parsers/packageJson.js";
import { loadCodeowners, CODEOWNERS_CANDIDATES } from "./parsers/codeowners.js";
import { detectCi, findTodos, CI_SOURCE_ROOTS, type TodoMarker } from "./parsers/ci.js";
import { listSourceFiles, directoriesOf } from "./parsers/walk.js";
import { buildModuleGraph } from "./parsers/imports.js";
import { tryRead } from "./parsers/fsUtil.js";
import { CONFIG_FILENAME, EMPTY_CONFIG, type CustomSectionConfig, type HandoverConfig } from "./config.js";

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

/** Cap on issues pulled from the tracker into Known Issues. */
const ISSUE_RENDER_LIMIT = 25;

/**
 * An open ticket from whatever tracker the team uses.
 *
 * Declared here rather than imported from `providers/` so core keeps knowing
 * nothing about hosting platforms — the provider `Issue` type is structurally
 * the same, and the CLI is what bridges the two.
 */
export interface KnownIssue {
  title: string;
  url: string;
  labels: string[];
}

export interface BuildSectionsOptions {
  /**
   * Open tracker issues to list under Known Issues. `undefined` means nobody
   * asked for them — which is reported differently from an empty array, so the
   * doc never claims a clean tracker it didn't actually read.
   */
  issues?: KnownIssue[];
  /** Per-repo config: custom sections, exclusions, ordering. */
  config?: HandoverConfig;
}

/**
 * Builds the list of sections for SERVICE.md. Each section knows exactly
 * which files it was derived from, so `handoverkit check` can recompute
 * its hash later and tell you precisely which section went stale and why.
 */
export async function buildSections(repoRoot: string, options: BuildSectionsOptions = {}): Promise<Section[]> {
  const config = options.config ?? EMPTY_CONFIG;
  const pkg = await loadPackageInfo(repoRoot);
  const readme = await tryRead(repoRoot, "README.md");
  const envVars = await loadEnvVars(repoRoot);
  const ci = await detectCi(repoRoot);
  const owners = await loadCodeowners(repoRoot);
  const scannedFiles = (await listSourceFiles(repoRoot, TODO_SCAN_LIMIT)).slice(0, TODO_SCAN_LIMIT);
  // Files catch edits and deletions; the directories they live in catch
  // additions. Without the directories, a file added after `generate` — a new
  // module, a new TODO — is invisible to `check`, because the recorded source
  // list was written before that file existed.
  const scannedSources = [...directoriesOf(scannedFiles), ...scannedFiles].sort();
  const todos = await findTodos(repoRoot, scannedFiles);
  // Only filter against package.json when there is one; a repo without it gives
  // us nothing to verify against, and an unfiltered list beats an empty one.
  const declaredPackages = pkg ? [...pkg.dependencies, ...pkg.devDependencies] : undefined;
  const graph = await buildModuleGraph(repoRoot, scannedFiles, declaredPackages);

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
    id: "architecture",
    title: "Architecture",
    sourceFiles: scannedSources,
    render: async () => {
      if (graph.modules.length === 0) {
        return "_No source files were scanned, so there's nothing to map here._";
      }
      const rows = graph.modules.map((m) => {
        const deps = m.dependsOn.length > 0 ? m.dependsOn.map((d) => `\`${d}\``).join(", ") : "_(nothing internal)_";
        return `| \`${m.dir}\` | ${m.fileCount} | ${deps} |`;
      });
      const table = ["| Directory | Files | Imports from |", "| --- | --- | --- |", ...rows].join("\n");

      const parts = [table];
      if (graph.packages.length > 0) {
        parts.push(`External packages imported: ${graph.packages.map((p) => `\`${p}\``).join(", ")}.`);
      }
      if (graph.pythonSeen) {
        parts.push(
          "_Python imports shape the table above, but their external packages aren't listed: an import name doesn't reliably map to a distribution name (`import yaml` comes from `PyYAML`)._"
        );
      }
      if (graph.unparsedCount > 0) {
        const n = graph.unparsedCount;
        parts.push(
          `_${n} scanned ${n === 1 ? "file is" : "files are"} in a language this tool doesn't parse for imports (it reads JavaScript/TypeScript, Python and Go)._`
        );
      }
      return parts.join("\n\n");
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
    // The roots are always included, not used as a fallback: hashing the
    // workflows *directory* alongside whichever files exist today is what makes
    // "a pipeline was added" detectable at all.
    sourceFiles: [...new Set([...CI_SOURCE_ROOTS, ...ci.files])].sort(),
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
    // Only the scanned files are hashed. Tracker issues deliberately are not:
    // nothing in the repo changes when somebody opens an issue, so folding them
    // into the hash would make `check` depend on a remote system's mood and
    // report drift on a commit that changed nothing.
    sourceFiles: scannedSources,
    render: async () => [renderTrackerIssues(options.issues), renderTodos(todos, scannedFiles.length)].join("\n\n"),
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

  return applyConfig(sections, config);
}

/**
 * Folds the repo's config into the built-in section list: drop what it
 * excludes, append what it declares, reorder if it says so.
 *
 * Exclusions and ordering are validated against the ids that actually exist
 * rather than ignored — a typo'd id should say so, not silently do nothing.
 */
function applyConfig(builtIns: Section[], config: HandoverConfig): Section[] {
  const builtInIds = new Set(builtIns.map((s) => s.id));

  for (const custom of config.sections) {
    if (builtInIds.has(custom.id)) {
      throw new Error(
        `${CONFIG_FILENAME}: section id "${custom.id}" is already a built-in section. Pick another id, or list it under "exclude" to replace it.`
      );
    }
  }

  for (const id of config.exclude) {
    if (!builtInIds.has(id)) {
      throw new Error(
        `${CONFIG_FILENAME}: "exclude" names "${id}", which isn't a built-in section. Known: ${[...builtInIds].join(", ")}.`
      );
    }
  }

  const kept = builtIns.filter((s) => !config.exclude.includes(s.id));
  const sections = [...kept, ...config.sections.map(toSection)];

  if (!config.order) return sections;

  const known = new Set(sections.map((s) => s.id));
  for (const id of config.order) {
    if (!known.has(id)) {
      throw new Error(
        `${CONFIG_FILENAME}: "order" names "${id}", which is neither a built-in nor a configured section.`
      );
    }
  }
  // Listed ids lead, in the given order; everything else keeps its relative
  // position behind them, so a partial order doesn't have to enumerate the lot.
  const ranked = config.order.map((id) => sections.find((s) => s.id === id)!);
  return [...ranked, ...sections.filter((s) => !config.order!.includes(s.id))];
}

function toSection(custom: CustomSectionConfig): Section {
  return {
    id: custom.id,
    title: custom.title,
    // The config file joins the section's own sources: change which files a
    // section tracks and it should re-baseline, same as changing the files.
    sourceFiles: [...new Set([CONFIG_FILENAME, ...custom.sources])].sort(),
    render: async () =>
      custom.body ??
      "_No generated content for this section — write what matters in the notes block below._",
  };
}

function renderTrackerIssues(issues: KnownIssue[] | undefined): string {
  const heading = "### From the issue tracker";
  if (issues === undefined) {
    return `${heading}\n\n_Not fetched. Re-run \`handoverkit generate --with-issues\` to list open tickets here._`;
  }
  if (issues.length === 0) {
    return `${heading}\n\n_No open issues._`;
  }
  // Sorted by URL: the API returns whatever order it likes, and an unstable
  // order would rewrite this section on every run for no reason.
  const sorted = [...issues].sort((a, b) => a.url.localeCompare(b.url));
  const rows = sorted.slice(0, ISSUE_RENDER_LIMIT).map((i) => {
    const labels = i.labels.length > 0 ? ` — ${i.labels.map((l) => `\`${l}\``).join(", ")}` : "";
    return `- [${escapeLinkText(i.title)}](${i.url})${labels}`;
  });
  const rest = sorted.length - ISSUE_RENDER_LIMIT;
  return [heading, "", ...rows, ...(rest > 0 ? ["", `_(${rest} more not shown)_`] : [])].join("\n");
}

/**
 * Assembled instead of written out: a markdown heading is "#" followed by a
 * space, which findTodos can't tell apart from a real comment marker. Spelling
 * the keywords literally here seeds two phantom entries into this repo's own
 * Known Issues — which is how this was found.
 */
export const TODO_HEADING = `### ${"TO" + "DO"}/${"FIX" + "ME"} in source`;

function renderTodos(todos: TodoMarker[], scannedCount: number): string {
  const heading = TODO_HEADING;
  if (todos.length === 0) {
    return `${heading}\n\n_None found in the ${scannedCount} scanned source files._`;
  }
  const rows = todos.slice(0, TODO_RENDER_LIMIT).map((t) => `- \`${t.file}:${t.line}\` — ${t.text}`);
  const rest = todos.length - TODO_RENDER_LIMIT;
  return [heading, "", ...rows, ...(rest > 0 ? ["", `_(${rest} more not shown)_`] : [])].join("\n");
}

/** Keeps a title containing brackets from breaking out of its markdown link. */
function escapeLinkText(title: string): string {
  return title.replace(/([[\]])/g, "\\$1");
}

export function extractFirstParagraph(markdown?: string): string | undefined {
  if (!markdown) return undefined;
  const withoutHeadings = markdown.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
  const joined = withoutHeadings.join("\n").trim();
  const firstParagraph = joined.split(/\n\s*\n/)[0];
  return firstParagraph?.trim() || undefined;
}
