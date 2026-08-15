import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { directoriesOf, withAncestors } from "../src/core/parsers/walk.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";

/** The two sections that scan a whole tree rather than a fixed path list. */
const SCANNING_SECTIONS = ["known-issues", "architecture"];

async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-scan-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function staleScanning(results: Awaited<ReturnType<typeof checkServiceMd>>): string[] {
  return results.filter((r) => r.stale && SCANNING_SECTIONS.includes(r.id)).map((r) => r.id).sort();
}

test("directoriesOf collects distinct parents and drops the repo root", () => {
  const dirs = directoriesOf(["src/a.ts", "src/b.ts", "src/core/c.ts", "top.ts"]);

  assert.deepEqual(dirs, ["src", "src/core"], "the root is excluded on purpose");
});

test("withAncestors adds the parents, still stopping short of the root", () => {
  assert.deepEqual(withAncestors(["src/core/parsers"]), ["src", "src/core", "src/core/parsers"]);
  assert.deepEqual(withAncestors(["src"]), ["src"]);
  assert.deepEqual(withAncestors([]), []);
});

test("a new directory under a parent that holds no files of its own is caught", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-nested-"));
  try {
    // `src` holds no source files directly, so tracking only the directories
    // that do would leave a whole new module landing unnoticed.
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await mkdir(path.join(root, "src", "api"), { recursive: true });
    await writeFile(path.join(root, "src", "api", "index.ts"), "export const a = 1;\n");
    const doc = await generateServiceMd(root);

    await mkdir(path.join(root, "src", "billing"), { recursive: true });
    await writeFile(path.join(root, "src", "billing", "index.ts"), "export const b = 1;\n");

    assert.deepEqual(staleScanning(await checkServiceMd(root, doc)), ["architecture", "known-issues"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adding a source file registers as drift", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);
    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), []);

    // Previously invisible: the recorded source list was written before this
    // file existed, so recomputing it found nothing changed.
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");

    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), ["architecture", "known-issues"]);
  });
});

test("adding a file containing a TODO registers as drift", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    await writeFile(path.join(root, "src", "b.ts"), `// ${"TO" + "DO"}: unfinished\nexport const b = 2;\n`);

    const known = (await checkServiceMd(root, content)).find((r) => r.id === "known-issues");
    assert.equal(known?.stale, true, "a marker nobody is told about is the whole failure mode");
  });
});

test("adding a nested directory registers as drift via its parent", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    await mkdir(path.join(root, "src", "workers"), { recursive: true });
    await writeFile(path.join(root, "src", "workers", "queue.ts"), 'import { a } from "../a.js";\n');

    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), ["architecture", "known-issues"]);
  });
});

test("changing and deleting files still register as drift", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    await writeFile(path.join(root, "src", "a.ts"), "export const a = 999;\n");
    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), ["architecture", "known-issues"]);

    await rm(path.join(root, "src", "a.ts"));
    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), ["architecture", "known-issues"]);
  });
});

test("an untouched repo stays quiet", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    assert.deepEqual((await checkServiceMd(root, content)).filter((r) => r.stale), []);
  });
});

test("generating twice in a row does not report itself as drifted", async () => {
  await withRepo(async (root) => {
    // The reason the repo root is not a tracked directory: generate writes
    // SERVICE.md after hashing, so tracking "." would stale every first run.
    const first = await generateServiceMd(root);
    await writeFile(path.join(root, "SERVICE.md"), first);

    assert.deepEqual((await checkServiceMd(root, first)).filter((r) => r.stale), []);
  });
});

test("scanned sections record their directories alongside their files", async () => {
  await withRepo(async (root) => {
    const sources = (await checkServiceMd(root, await generateServiceMd(root))).find(
      (r) => r.id === "known-issues"
    )?.sources;

    assert.deepEqual(sources, ["src", "src/a.ts"]);
  });
});

test("a file added at the repo root is the documented blind spot", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    await writeFile(path.join(root, "top.ts"), "export const top = 1;\n");

    // Honest limitation, not an oversight: tracking "." would mean tracking
    // SERVICE.md itself. Regenerating picks the file up.
    assert.deepEqual(staleScanning(await checkServiceMd(root, content)), []);
    assert.match(await generateServiceMd(root), /top\.ts/);
  });
});
