import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME } from "./config.js";
import { tryRead } from "./parsers/fsUtil.js";

/**
 * Scaffolds handoverkit.config.json.
 *
 * Writing one by hand means guessing at the schema and at which built-in ids
 * are legal to exclude — and a guess that's wrong only surfaces when generate
 * refuses to run. The starter file is deliberately valid as written, so the
 * first `generate` after `init` succeeds and the example can be edited from a
 * working state rather than a broken one.
 *
 * JSON has no comments, so the guidance lives in the example section's own
 * body and in what the CLI prints afterwards.
 */
export function renderStarterConfig(): string {
  const starter = {
    sections: [
      {
        id: "runbook",
        title: "Runbook",
        sources: ["docs/runbook.md"],
        body: 'What to do when this breaks. Drop "body" to leave the section as a tracked heading plus a notes block, which is often what you want.',
      },
    ],
    exclude: [],
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}

export class ConfigExistsError extends Error {
  constructor(readonly file: string) {
    super(`${file} already exists. Pass --force to overwrite it.`);
    this.name = "ConfigExistsError";
  }
}

/**
 * Writes the starter config, refusing to clobber an existing one.
 *
 * Overwriting silently would discard section definitions that are load-bearing
 * for someone's document — the same reasoning behind refusing to regenerate
 * over an unterminated notes block.
 */
export async function writeStarterConfig(
  repoRoot: string,
  options: { out?: string; force?: boolean } = {}
): Promise<string> {
  const file = options.out ?? CONFIG_FILENAME;
  if (!options.force && (await tryRead(repoRoot, file)) !== undefined) {
    throw new ConfigExistsError(file);
  }
  await writeFile(path.resolve(repoRoot, file), renderStarterConfig(), "utf8");
  return file;
}
