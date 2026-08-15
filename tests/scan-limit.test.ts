import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DISCOVERY_CEILING, scanSourceFiles } from "../src/core/parsers/walk.js";
import { parseConfig, CONFIG_FILENAME } from "../src/core/config.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";

const MARKER = "TO" + "DO";

/**
 * A repo shaped like the one that exposed the bug: a large, alphabetically
 * early directory that used to swallow the whole budget, and a late one
 * holding something worth finding.
 */
async function withLopsidedRepo(bulk: number, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-cap-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "big" }));
    await mkdir(path.join(root, "aaa"), { recursive: true });
    for (let i = 0; i < bulk; i++) {
      await writeFile(path.join(root, "aaa", `m${String(i).padStart(4, "0")}.ts`), `export const m${i} = ${i};\n`);
    }
    await mkdir(path.join(root, "zzz"), { recursive: true });
    await writeFile(path.join(root, "zzz", "billing.ts"), `// ${MARKER}: refunds are unimplemented\nexport const b = 1;\n`);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `expected a ${heading} section`);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

test("every directory is represented before any directory repeats", async () => {
  await withLopsidedRepo(50, async (root) => {
    const scan = await scanSourceFiles(root, 10);

    const dirs = new Set(scan.files.map((f) => path.posix.dirname(f)));
    assert.deepEqual([...dirs].sort(), ["aaa", "zzz"], "a first-N-in-walk-order scan misses zzz entirely");
  });
});

test("a marker in a late-sorting directory is still found", async () => {
  await withLopsidedRepo(210, async (root) => {
    const doc = await generateServiceMd(root);

    assert.match(sectionOf(doc, "Known Issues"), /zzz\/billing\.ts:1.*refunds are unimplemented/);
  });
});

test("truncation is stated, not left silent", async () => {
  await withLopsidedRepo(210, async (root) => {
    const doc = await generateServiceMd(root);

    // "No TODOs found" after reading 200 of 211 files is a false statement in
    // every way that matters to a reader.
    for (const heading of ["Known Issues", "Architecture"]) {
      assert.match(sectionOf(doc, heading), /Scanned 200 of 211 source files/);
      assert.match(sectionOf(doc, heading), /neither read nor covered by this section's drift check/);
    }
  });
});

test("a repo inside the limit says nothing about truncation", async () => {
  await withLopsidedRepo(5, async (root) => {
    const doc = await generateServiceMd(root);

    assert.doesNotMatch(doc, /Scanned \d+ of/);
  });
});

test("the scan reports how much it left unread", async () => {
  await withLopsidedRepo(30, async (root) => {
    const scan = await scanSourceFiles(root, 10);

    assert.equal(scan.files.length, 10);
    assert.equal(scan.totalFound, 31);
    assert.equal(scan.truncated, true);
    assert.equal(scan.discoveryCapped, false);
  });
});

test("an untruncated scan is not marked truncated", async () => {
  await withLopsidedRepo(3, async (root) => {
    const scan = await scanSourceFiles(root, 100);

    assert.equal(scan.truncated, false);
    assert.equal(scan.totalFound, scan.files.length);
  });
});

test("selection is deterministic and sorted", async () => {
  await withLopsidedRepo(40, async (root) => {
    const once = await scanSourceFiles(root, 15);
    const twice = await scanSourceFiles(root, 15);

    assert.deepEqual(once.files, twice.files);
    assert.deepEqual(once.files, [...once.files].sort());
  });
});

test("scanLimit in config widens the scan", async () => {
  await withLopsidedRepo(210, async (root) => {
    await writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({ scanLimit: 500 }));

    const doc = await generateServiceMd(root);

    assert.doesNotMatch(doc, /Scanned \d+ of/, "raising the limit past the repo size removes the caveat");
    assert.match(sectionOf(doc, "Architecture"), /\| `aaa` \| 210 \|/);
  });
});

test("widening the scan brings previously invisible files under drift detection", async () => {
  await withLopsidedRepo(210, async (root) => {
    await writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({ scanLimit: 500 }));
    const doc = await generateServiceMd(root);

    await writeFile(path.join(root, "aaa", "m0209.ts"), "export const changed = true;\n");

    const stale = (await checkServiceMd(root, doc)).filter((r) => r.stale).map((r) => r.id);
    assert.deepEqual(stale.sort(), ["architecture", "known-issues"]);
  });
});

test("scanLimit must be a positive whole number", () => {
  for (const bad of [0, -5, 1.5, "200"]) {
    assert.throws(
      () => parseConfig(JSON.stringify({ scanLimit: bad })),
      /must be a positive whole number/,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("scanLimit above the discovery ceiling is rejected rather than silently ignored", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ scanLimit: DISCOVERY_CEILING + 1 })),
    new RegExp(`at most ${DISCOVERY_CEILING}`)
  );
  assert.equal(parseConfig(JSON.stringify({ scanLimit: DISCOVERY_CEILING })).scanLimit, DISCOVERY_CEILING);
});

test("omitting scanLimit leaves it unset rather than defaulting in the config", () => {
  assert.equal(parseConfig("{}").scanLimit, undefined);
});
