import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditOwnership, isLiteralPattern, patternToPath, parseCodeowners } from "../src/core/parsers/codeowners.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd, type DriftResult } from "../src/core/check.js";

async function withRepo(codeowners: string | undefined, dirs: string[], fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-own-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    for (const dir of dirs) {
      await mkdir(path.join(root, dir), { recursive: true });
      await writeFile(path.join(root, dir, "index.ts"), "export const x = 1;\n");
    }
    if (codeowners !== undefined) await writeFile(path.join(root, "CODEOWNERS"), codeowners);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ownership(results: DriftResult[]): DriftResult {
  const found = results.find((r) => r.id === "ownership");
  assert.ok(found, "expected an ownership section");
  return found;
}

function ownershipSection(doc: string): string {
  const start = doc.indexOf("## Ownership");
  assert.notEqual(start, -1);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

test("patterns are normalised and classified", () => {
  assert.equal(patternToPath("/src/api/"), "src/api");
  assert.equal(patternToPath("src/api"), "src/api");
  assert.equal(isLiteralPattern("src/api/"), true);
  assert.equal(isLiteralPattern("*.ts"), false);
  assert.equal(isLiteralPattern("src/**/api"), false);
});

test("an entry naming a path that doesn't exist is flagged", async () => {
  await withRepo("src/api/ @alice\nsrc/legacy/ @carol\n", ["src/api"], async (root) => {
    const section = ownershipSection(await generateServiceMd(root));

    assert.match(section, /`src\/legacy\/` \| @carol — ⚠️ _path not found_/);
    assert.match(section, /1 entry names a path that no longer exists\. Remove it/);
    assert.doesNotMatch(section, /`src\/api\/` \| @alice — ⚠️/, "a valid entry must not be accused");
  });
});

test("plural wording when several entries point nowhere", async () => {
  await withRepo("a/ @x\nb/ @y\n", ["src"], async (root) => {
    assert.match(ownershipSection(await generateServiceMd(root)), /2 entries name paths that no longer exist/);
  });
});

test("a directory with code and no owner is named", async () => {
  await withRepo("src/api/ @alice\n", ["src/api", "src/workers"], async (root) => {
    const section = ownershipSection(await generateServiceMd(root));

    // The old table listed only covered paths, which reads as full coverage.
    assert.match(section, /No owner listed for: `src\/workers`/);
    assert.doesNotMatch(section, /No owner listed for:[^_]*src\/api/);
  });
});

test("full coverage says nothing about gaps", async () => {
  await withRepo("src/ @alice\n", ["src/api", "src/core"], async (root) => {
    const section = ownershipSection(await generateServiceMd(root));

    assert.doesNotMatch(section, /No owner listed/);
    assert.doesNotMatch(section, /path not found/);
  });
});

test("glob patterns are reported as unchecked rather than guessed at", async () => {
  await withRepo("*.ts @alice\nsrc/api/ @bob\n", ["src/api"], async (root) => {
    const section = ownershipSection(await generateServiceMd(root));

    assert.match(section, /Not checked against the repo \(matching these needs a glob engine\): `\*\.ts`/);
    assert.doesNotMatch(section, /`\*\.ts` \| @alice — ⚠️/, "a glob must never be accused of pointing nowhere");
  });
});

test("deleting an owned directory makes Ownership drift", async () => {
  await withRepo("src/api/ @alice\nsrc/core/ @bob\n", ["src/api", "src/core"], async (root) => {
    const doc = await generateServiceMd(root);
    assert.equal(ownership(await checkServiceMd(root, doc)).stale, false);

    await rm(path.join(root, "src", "api"), { recursive: true, force: true });

    const result = ownership(await checkServiceMd(root, doc));
    assert.equal(result.stale, true, "the table was claiming an owner for a directory that is gone");
    assert.deepEqual(
      (result.changes ?? []).filter((c) => c.kind === "removed").map((c) => c.path),
      ["src/api"]
    );
  });
});

test("Ownership tracks the paths CODEOWNERS names, not just the file", async () => {
  await withRepo("src/api/ @alice\n", ["src/api"], async (root) => {
    const sources = ownership(await checkServiceMd(root, await generateServiceMd(root))).sources;

    assert.ok(sources.includes("src/api"), "an owned path has to be tracked for its removal to register");
    assert.ok(sources.includes("CODEOWNERS"));
  });
});

test("a new unowned directory does not drift Ownership, but the scanning sections do", async () => {
  await withRepo("src/api/ @alice\n", ["src/api"], async (root) => {
    const doc = await generateServiceMd(root);

    await mkdir(path.join(root, "src", "billing"), { recursive: true });
    await writeFile(path.join(root, "src", "billing", "index.ts"), "export const b = 1;\n");

    const results = await checkServiceMd(root, doc);

    // Honest limitation: nothing Ownership tracks changed. The reviewer still
    // gets told to regenerate, which refreshes the unowned list.
    assert.equal(ownership(results).stale, false);
    assert.deepEqual(
      results.filter((r) => r.stale).map((r) => r.id).sort(),
      ["architecture", "known-issues"]
    );
    assert.match(ownershipSection(await generateServiceMd(root)), /No owner listed for: `src\/billing`/);
  });
});

test("a repo with no CODEOWNERS still says what to do", async () => {
  await withRepo(undefined, ["src"], async (root) => {
    assert.match(ownershipSection(await generateServiceMd(root)), /No CODEOWNERS file found/);
  });
});

test("auditOwnership reports the three categories separately", async () => {
  await withRepo("src/api/ @alice\ngone/ @bob\n*.ts @carol\n", ["src/api", "src/workers"], async (root) => {
    const entries = parseCodeowners("src/api/ @alice\ngone/ @bob\n*.ts @carol\n");

    const audit = await auditOwnership(root, entries, ["src/api", "src/workers"]);

    assert.deepEqual(audit.missing, ["gone"]);
    assert.deepEqual(audit.unowned, ["src/workers"]);
    assert.deepEqual(audit.unchecked, ["*.ts"]);
  });
});

test("a pattern covering a parent directory covers what's beneath it", async () => {
  const audit = await auditOwnership(process.cwd(), parseCodeowners("src/ @alice\n"), [
    "src",
    "src/core",
    "src/core/parsers",
  ]);

  assert.deepEqual(audit.unowned, []);
});
