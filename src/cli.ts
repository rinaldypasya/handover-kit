#!/usr/bin/env node
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { generateServiceMd } from "./core/generate.js";
import { buildSections, type KnownIssue } from "./core/sections.js";
import { CONFIG_FILENAME } from "./core/config.js";
import { writeStarterConfig } from "./core/init.js";
import {
  checkServiceMd,
  compareDocumentedIssues,
  extractDocumentedIssueUrls,
  formatDriftReport,
  formatIssueNote,
} from "./core/check.js";
import { countHandWrittenNotes } from "./core/notes.js";
import { tryRead } from "./core/parsers/fsUtil.js";
import { getProvider } from "./providers/VcsProvider.js";

const program = new Command();

program
  .name("handoverkit")
  .description("Generate and verify a living SERVICE.md so service handovers don't start from zero.");

program
  .command("generate")
  .description("Scan the repo and (re)write SERVICE.md")
  .option("-o, --out <file>", "output file", "SERVICE.md")
  .option("-r, --root <dir>", "repo root to scan", ".")
  .option("--with-issues", "also list open GitHub/GitLab issues under Known Issues", false)
  .option("--issue-labels <labels>", "comma-separated labels to filter fetched issues")
  .option("-c, --config <file>", `config file (defaults to ${CONFIG_FILENAME} when present)`)
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.root);
    const outPath = path.resolve(repoRoot, opts.out);
    const issues = opts.withIssues ? await fetchIssues(opts.issueLabels) : undefined;
    // Read the file we're about to overwrite first: that's what carries the
    // hand-written notes blocks forward. countHandWrittenNotes runs before the
    // write so a malformed block aborts the command instead of eating prose.
    const previous = await tryRead(repoRoot, opts.out);
    const carried = previous ? countHandWrittenNotes(previous) : 0;

    const content = await generateServiceMd(repoRoot, { previous, issues, configPath: opts.config });
    await writeFile(outPath, content, "utf8");

    // Whichever reads better: a relative path climbing out of cwd with a
    // stack of "../" is noisier than just printing the absolute one.
    const relative = path.relative(process.cwd(), outPath);
    const where = relative && relative.length < outPath.length ? relative : outPath;
    const suffix = carried > 0 ? ` (kept ${carried} hand-written notes block${carried === 1 ? "" : "s"})` : "";
    console.log(`[handoverkit] wrote ${where}${suffix}`);
  });

program
  .command("init")
  .description(`Write a starter ${CONFIG_FILENAME} and list the built-in section ids`)
  .option("-r, --root <dir>", "repo root", ".")
  .option("-o, --out <file>", "config file to write", CONFIG_FILENAME)
  .option("--force", "overwrite an existing config file", false)
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.root);
    const file = await writeStarterConfig(repoRoot, { out: opts.out, force: opts.force });

    // Read the ids off the real section list rather than a hard-coded copy, so
    // this can't drift from what `exclude` and `order` will actually accept.
    const builtInIds = (await buildSections(repoRoot)).map((s) => s.id);

    console.log(`[handoverkit] wrote ${file}`);
    console.log(`[handoverkit] built-in section ids for "exclude" and "order": ${builtInIds.join(", ")}`);
    console.log(`[handoverkit] edit the example section (or delete it), then run \`handoverkit generate\`.`);
  });

program
  .command("check")
  .description("Compare SERVICE.md against its source files and report drift")
  .option("-f, --file <file>", "SERVICE.md path", "SERVICE.md")
  .option("-r, --root <dir>", "repo root to scan", ".")
  .option("--ci", "exit with code 1 if any section is stale (for CI gating)", false)
  .option("--post-comment", "post the drift report as a PR/MR comment", false)
  .option("--with-issues", "also compare the documented ticket list against the tracker (advisory)", false)
  .option("--issue-labels <labels>", "comma-separated labels to filter fetched issues")
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.root);
    const content = await tryRead(repoRoot, opts.file);
    if (content === undefined) {
      console.error(`[handoverkit] ${opts.file} not found. Run \`handoverkit generate\` first.`);
      process.exitCode = 1;
      return;
    }

    const results = await checkServiceMd(repoRoot, content);
    const issueNote = opts.withIssues ? await buildIssueNote(content, opts.issueLabels) : undefined;
    const report = [formatDriftReport(results), issueNote].filter(Boolean).join("\n\n");
    console.log(report);

    if (opts.postComment) {
      const provider = await getProvider();
      try {
        await provider.postComment({}, report);
      } catch (err) {
        // A comment we couldn't post shouldn't mask the drift verdict itself —
        // that verdict is the reason the job runs. Warn and let --ci decide.
        console.warn(`[handoverkit] could not post comment: ${errorMessage(err)}`);
      }
    }

    // Only file-derived drift gates CI. The issue note is information; letting
    // a remote tracker decide the exit code would fail builds on commits that
    // changed nothing.
    const anyStale = results.some((r) => r.stale);
    if (opts.ci && anyStale) {
      process.exitCode = 1;
    }
  });

async function buildIssueNote(serviceMd: string, rawLabels?: string): Promise<string | undefined> {
  const documented = extractDocumentedIssueUrls(serviceMd);
  if (documented === undefined) {
    console.warn(
      "[handoverkit] --with-issues: SERVICE.md has no recorded ticket list. " +
        "Run `handoverkit generate --with-issues` first."
    );
    return undefined;
  }
  const open = await fetchIssues(rawLabels);
  if (open === undefined) return undefined;
  return formatIssueNote(compareDocumentedIssues(documented, open));
}

/**
 * Reads open tickets from whichever provider the environment points at.
 *
 * Returns undefined — not [] — whenever the tracker couldn't actually be read,
 * so the doc says "not fetched" rather than asserting a clean tracker nobody
 * looked at.
 */
async function fetchIssues(rawLabels?: string): Promise<KnownIssue[] | undefined> {
  const provider = await getProvider();
  if (provider.name === "none") {
    console.warn(
      "[handoverkit] --with-issues: no GitHub/GitLab credentials found " +
        "(set GITHUB_TOKEN + GITHUB_REPOSITORY, or GITLAB_TOKEN + CI_PROJECT_ID). Skipping issue fetch."
    );
    return undefined;
  }
  const labels = (rawLabels ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  try {
    return await provider.getOpenIssues(labels);
  } catch (err) {
    console.warn(`[handoverkit] could not fetch issues from ${provider.name}: ${errorMessage(err)}`);
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

program.parseAsync(process.argv).catch((err) => {
  // Without this, any rejection surfaces as an unhandled-rejection stack trace
  // and (on Node 18+) a non-descript crash rather than a readable CI failure.
  console.error(`[handoverkit] ${errorMessage(err)}`);
  process.exit(1);
});
