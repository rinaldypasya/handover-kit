import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkServiceMd, formatDriftReport, type DriftResult } from "../src/core/check.js";
import { generateServiceMd } from "../src/core/generate.js";

/**
 * Enough files that a section's source list is long — the condition under
 * which naming the first few alphabetically was actively misleading.
 */
async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-attr-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "billing" }));
    await writeFile(path.join(root, ".env.example"), "# Port\nPORT=3000\n");
    for (const dir of ["api", "core", "workers"]) {
      await mkdir(path.join(root, dir), { recursive: true });
      for (let i = 0; i < 6; i++) {
        await writeFile(path.join(root, dir, `f${i}.ts`), `export const ${dir}${i} = ${i};\n`);
      }
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sectionOf(results: DriftResult[], id: string): DriftResult {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `expected a section with id=${id}`);
  return found;
}

function changesOf(results: DriftResult[], id: string, kind: string): string[] {
  return (sectionOf(results, id).changes ?? []).filter((c) => c.kind === kind).map((c) => c.path).sort();
}

test("an edited file is named, and innocent files are not", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");

    const results = await checkServiceMd(root, doc);
    assert.deepEqual(changesOf(results, "known-issues", "changed"), ["core/f3.ts"]);

    // The regression: the report used to list api/f0.ts..api/f3.ts, none of
    // which had moved, and hide the real one behind "(+28 more)".
    const report = formatDriftReport(results);
    assert.match(report, /core\/f3\.ts/);
    assert.doesNotMatch(report, /api\/f0\.ts/);
  });
});

test("a deleted file is reported as removed", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    await rm(path.join(root, "api", "f2.ts"));

    assert.deepEqual(changesOf(await checkServiceMd(root, doc), "known-issues", "removed"), ["api/f2.ts"]);
  });
});

test("a new file is reported as added, via the directory that now holds it", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    await writeFile(path.join(root, "workers", "queue.ts"), "export const q = 1;\n");

    assert.deepEqual(changesOf(await checkServiceMd(root, doc), "known-issues", "added"), ["workers/queue.ts"]);
  });
});

test("all three kinds are counted and listed together", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");
    await writeFile(path.join(root, "workers", "queue.ts"), "export const q = 1;\n");
    await rm(path.join(root, "api", "f2.ts"));

    const report = formatDriftReport(await checkServiceMd(root, doc));

    assert.match(report, /1 file changed, 1 added, 1 removed/);
    assert.match(report, /- changed: `core\/f3\.ts`/);
    assert.match(report, /- added: `workers\/queue\.ts`/);
    assert.match(report, /- removed: `api\/f2\.ts`/);
  });
});

test("a section with few sources names the one that moved", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    await writeFile(path.join(root, ".env.example"), "# Port\nPORT=3000\nDEBUG=true\n");

    const results = await checkServiceMd(root, doc);

    // .env.sample and .env.template are tracked-but-absent; neither moved.
    assert.deepEqual(changesOf(results, "environment", "changed"), [".env.example"]);
    assert.match(formatDriftReport(results), /1 file changed/);
  });
});

test("a clean repo attributes nothing", async () => {
  await withRepo(async (root) => {
    const results = await checkServiceMd(root, await generateServiceMd(root));

    assert.deepEqual(results.filter((r) => r.stale), []);
    assert.deepEqual(results.map((r) => r.changes), results.map(() => undefined));
  });
});

test("a document written before digests existed still parses, and says so", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);
    const legacy = doc.replace(/ digests=\S+/g, "");
    assert.doesNotMatch(legacy, /digests=/);

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");
    const results = await checkServiceMd(root, legacy);

    assert.equal(sectionOf(results, "known-issues").stale, true, "drift detection must not depend on digests");
    assert.equal(sectionOf(results, "known-issues").changes, undefined);
    assert.match(formatDriftReport(results), /regenerate to record which file changed/);
  });
});

test("a digest list that doesn't line up is ignored rather than guessed at", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);
    // Truncating the digests would misalign every source after the cut, naming
    // files that never moved — exactly the failure being fixed.
    const damaged = doc.replace(/digests=\S+/g, "digests=deadbeef");

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");
    const results = await checkServiceMd(root, damaged);

    assert.equal(sectionOf(results, "known-issues").changes, undefined);
  });
});

test("digests survive a CRLF checkout", async () => {
  await withRepo(async (root) => {
    const doc = (await generateServiceMd(root)).replace(/\n/g, "\r\n");

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");
    const results = await checkServiceMd(root, doc);

    assert.deepEqual(changesOf(results, "known-issues", "changed"), ["core/f3.ts"]);
  });
});

test("long lists are truncated per category", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);

    for (let i = 0; i < 6; i++) {
      await writeFile(path.join(root, "core", `f${i}.ts`), `export const core${i} = 999;\n`);
    }

    const report = formatDriftReport(await checkServiceMd(root, doc));

    assert.match(report, /6 files changed/);
    assert.match(report, /_\(\+1 more\)_/);
  });
});

test("recording digests doesn't change the drift verdict itself", async () => {
  await withRepo(async (root) => {
    const doc = await generateServiceMd(root);
    const withoutDigests = doc.replace(/ digests=\S+/g, "");

    await writeFile(path.join(root, "core", "f3.ts"), "export const core3 = 999;\n");

    const withStale = (await checkServiceMd(root, doc)).filter((r) => r.stale).map((r) => r.id);
    const withoutStale = (await checkServiceMd(root, withoutDigests)).filter((r) => r.stale).map((r) => r.id);

    assert.deepEqual(withStale, withoutStale);
  });
});
