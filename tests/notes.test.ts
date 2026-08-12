import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";
import {
  NOTES_PLACEHOLDER,
  countHandWrittenNotes,
  extractNotes,
  isEmptyNotes,
  renderNotesBlock,
} from "../src/core/notes.js";

async function withFixtureRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-notes-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "billing-api", description: "Charges people.", scripts: { dev: "node ." } }, null, 2)
    );
    await writeFile(path.join(root, "README.md"), "# billing-api\n\nCharges people.\n");
    await writeFile(path.join(root, ".env.example"), "# Listen port\nPORT=3000\n");
    await writeFile(path.join(root, "CODEOWNERS"), "src/  @alice\n");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Replaces a section's notes body the way a human editing the file would. */
function writeNotes(serviceMd: string, id: string, body: string): string {
  const before = extractNotes(serviceMd).get(id);
  assert.notEqual(before, undefined, `fixture should already have a notes block for ${id}`);
  return serviceMd.replace(renderNotesBlock(id, before ?? ""), renderNotesBlock(id, body));
}

const PROSE = "Postgres runs on the shared cluster. Ask #infra before touching the connection pool.";

test("every section gets a notes block on first generate", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    const ids = (await checkServiceMd(root, content)).map((r) => r.id);
    const notes = extractNotes(content);

    for (const id of ids) {
      assert.ok(notes.has(id), `section ${id} should have somewhere to write notes`);
      assert.ok(isEmptyNotes(notes.get(id) ?? ""), `section ${id} should start empty`);
    }
  });
});

test("hand-written notes survive regeneration", async () => {
  await withFixtureRepo(async (root) => {
    const edited = writeNotes(await generateServiceMd(root), "environment", PROSE);

    // The thing that used to blow the notes away: a source file changed, so the
    // section's generated half genuinely has to be rewritten.
    await writeFile(path.join(root, ".env.example"), "# Listen port\nPORT=8080\nDEBUG=true\n");
    const regenerated = await generateServiceMd(root, { previous: edited });

    assert.equal(extractNotes(regenerated).get("environment"), PROSE);
    assert.match(regenerated, /DEBUG/, "the generated half must still be refreshed");
    assert.doesNotMatch(regenerated, /PORT=3000/);
  });
});

test("notes survive across several regenerations", async () => {
  await withFixtureRepo(async (root) => {
    let content = writeNotes(await generateServiceMd(root), "ownership", PROSE);
    for (let i = 0; i < 3; i++) {
      content = await generateServiceMd(root, { previous: content });
    }
    assert.equal(extractNotes(content).get("ownership"), PROSE);
  });
});

test("regenerating an unchanged repo with notes is byte-identical", async () => {
  await withFixtureRepo(async (root) => {
    const edited = writeNotes(await generateServiceMd(root), "overview", PROSE);
    const once = await generateServiceMd(root, { previous: edited });
    const twice = await generateServiceMd(root, { previous: once });

    assert.equal(once, twice, "generate must be idempotent or CI will see phantom diffs");
  });
});

test("editing notes never marks a section as drifted", async () => {
  await withFixtureRepo(async (root) => {
    const edited = writeNotes(await generateServiceMd(root), "local-setup", PROSE);
    const results = await checkServiceMd(root, edited);

    assert.deepEqual(results.filter((r) => r.stale).map((r) => r.id), []);
  });
});

test("multi-line notes, including markdown, come back verbatim", async () => {
  await withFixtureRepo(async (root) => {
    const body = ["### Runbook", "", "1. Check the queue depth", "2. Restart the worker", "", "> Owned by @alice"].join("\n");
    const edited = writeNotes(await generateServiceMd(root), "deployment", body);

    const regenerated = await generateServiceMd(root, { previous: edited });

    assert.equal(extractNotes(regenerated).get("deployment"), body);
  });
});

test("an unterminated notes block aborts instead of discarding prose", async () => {
  await withFixtureRepo(async (root) => {
    const edited = writeNotes(await generateServiceMd(root), "environment", PROSE);
    const damaged = edited.replace("<!-- handoverkit:notes:end id=environment -->", "");

    await assert.rejects(
      () => generateServiceMd(root, { previous: damaged }),
      /opened but never closed \(id=environment\)/
    );
  });
});

test("a start marker won't pair with another section's end marker", () => {
  // Left unchecked, this is how one damaged block quietly absorbs the next
  // section's generated content and reports the wrong id as broken.
  const doc = [renderNotesBlock("environment", PROSE), renderNotesBlock("ownership", "owner prose")]
    .join("\n\n")
    .replace("<!-- handoverkit:notes:end id=environment -->", "");

  assert.throws(() => extractNotes(doc), /never closed \(id=environment\)/);
});

test("notes for a section that no longer exists are parked, not dropped", async () => {
  await withFixtureRepo(async (root) => {
    const withOrphan =
      (await generateServiceMd(root)) + `\n## Retired\n${renderNotesBlock("retired-section", PROSE)}\n`;

    const regenerated = await generateServiceMd(root, { previous: withOrphan });

    assert.match(regenerated, /## Unfiled Notes/);
    assert.equal(extractNotes(regenerated).get("retired-section"), PROSE);
  });
});

test("an empty orphan block is dropped rather than parked forever", async () => {
  await withFixtureRepo(async (root) => {
    const withOrphan =
      (await generateServiceMd(root)) + `\n## Retired\n${renderNotesBlock("retired-section", "")}\n`;

    const regenerated = await generateServiceMd(root, { previous: withOrphan });

    assert.doesNotMatch(regenerated, /Unfiled Notes/);
    assert.equal(extractNotes(regenerated).has("retired-section"), false);
  });
});

test("notes written with CRLF endings are preserved", async () => {
  await withFixtureRepo(async (root) => {
    const edited = writeNotes(await generateServiceMd(root), "environment", PROSE).replace(/\n/g, "\r\n");

    const regenerated = await generateServiceMd(root, { previous: edited });

    assert.equal(extractNotes(regenerated).get("environment"), PROSE);
  });
});

test("duplicate blocks for one id are merged instead of losing one", () => {
  const doc = `${renderNotesBlock("environment", "first half")}\n\n${renderNotesBlock("environment", "second half")}`;

  assert.equal(extractNotes(doc).get("environment"), "first half\n\nsecond half");
});

test("countHandWrittenNotes ignores untouched placeholders", async () => {
  await withFixtureRepo(async (root) => {
    const fresh = await generateServiceMd(root);
    assert.equal(countHandWrittenNotes(fresh), 0);

    assert.equal(countHandWrittenNotes(writeNotes(fresh, "overview", PROSE)), 1);
  });
});

test("the placeholder is invisible to the drift parser", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    const results = await checkServiceMd(root, content);

    assert.ok(content.includes(NOTES_PLACEHOLDER));
    assert.equal(results.some((r) => r.id.includes("notes")), false, "notes markers must not parse as sections");
  });
});
