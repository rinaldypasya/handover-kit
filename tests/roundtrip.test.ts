import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd, formatDriftReport } from "../src/core/check.js";
import { REPORT_MARKER } from "../src/marker.js";

/** A minimal but realistic repo: the fixture every round-trip test starts from. */
async function withFixtureRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-rt-"));
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

function section(results: Awaited<ReturnType<typeof checkServiceMd>>, id: string) {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `expected a section with id=${id}`);
  return found;
}

test("a freshly generated SERVICE.md reports no drift", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    const results = await checkServiceMd(root, content);

    assert.ok(results.length >= 6, "every section should be parsed back out");
    assert.deepEqual(
      results.filter((r) => r.stale).map((r) => r.id),
      []
    );
  });
});

test("changing a source file marks exactly the section that depends on it", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    await writeFile(path.join(root, ".env.example"), "# Listen port\nPORT=3000\nDEBUG=true\n");

    const results = await checkServiceMd(root, content);

    assert.equal(section(results, "environment").stale, true);
    assert.equal(section(results, "ownership").stale, false);
    assert.equal(section(results, "local-setup").stale, false);
  });
});

test("regenerating after a change re-baselines the stored hash", async () => {
  await withFixtureRepo(async (root) => {
    const stale = await generateServiceMd(root);
    await writeFile(path.join(root, ".env.example"), "# Listen port\nPORT=8080\n");
    assert.equal(section(await checkServiceMd(root, stale), "environment").stale, true);

    const regenerated = await generateServiceMd(root);
    assert.equal(section(await checkServiceMd(root, regenerated), "environment").stale, false);
  });
});

test("the generated header is a single well-formed HTML comment", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);

    // HTML comments don't nest: everything the header means to say has to sit
    // before the first "-->", or it leaks into the rendered document.
    const header = content.slice(0, content.indexOf("-->"));
    assert.ok(header.includes("Freely edit the prose"), "header text must not leak past its closing tag");
  });
});

test("parsing survives CRLF line endings", async () => {
  await withFixtureRepo(async (root) => {
    const content = (await generateServiceMd(root)).replace(/\n/g, "\r\n");
    const results = await checkServiceMd(root, content);

    assert.ok(results.length >= 6, "CRLF checkout must not hide every section");
    assert.deepEqual(results.filter((r) => r.stale).map((r) => r.id), []);
  });
});

test("Deployment lists both pipelines when a repo runs GitHub Actions and GitLab CI", async () => {
  await withFixtureRepo(async (root) => {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
    await writeFile(path.join(root, ".gitlab-ci.yml"), "stages: [test]\n");

    const content = await generateServiceMd(root);

    assert.match(content, /GitHub Actions/);
    assert.match(content, /GitLab CI/);
  });
});

test("Known Issues hashes exactly the files it scanned", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    const sources = section(await checkServiceMd(root, content), "known-issues").sources;

    assert.deepEqual(sources, ["src/index.ts"]);
  });
});

// See tests/parsers.test.ts — assembled at runtime so this file doesn't seed a
// phantom entry into the repo's own Known Issues section.
const FIXME = "FIX" + "ME";

test("adding a marker to a scanned file both shows up and marks the section stale", async () => {
  await withFixtureRepo(async (root) => {
    const before = await generateServiceMd(root);
    assert.match(before, /markers found/);

    await writeFile(path.join(root, "src", "index.ts"), `// ${FIXME}: handle refunds\nexport const x = 1;\n`);

    assert.equal(section(await checkServiceMd(root, before), "known-issues").stale, true);
    assert.match(await generateServiceMd(root), /src\/index\.ts:1.*handle refunds/);
  });
});

test("the drift report carries the marker used to update an existing PR comment", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root);
    const clean = formatDriftReport(await checkServiceMd(root, content));

    await writeFile(path.join(root, "CODEOWNERS"), "src/  @bob\n");
    const dirty = formatDriftReport(await checkServiceMd(root, content));

    assert.ok(clean.startsWith(REPORT_MARKER));
    assert.ok(dirty.startsWith(REPORT_MARKER));
    assert.match(clean, /up to date/);
    assert.match(dirty, /Ownership/);
  });
});

test("a SERVICE.md with no tracked sections is reported, not silently passed", async () => {
  await withFixtureRepo(async (root) => {
    const results = await checkServiceMd(root, "# Service Handover Doc\n\nHand-written, no metadata.\n");

    assert.deepEqual(results, []);
    assert.match(formatDriftReport(results), /no tracked sections/);
  });
});

test("generate is deterministic for an unchanged repo", async () => {
  await withFixtureRepo(async (root) => {
    assert.equal(await generateServiceMd(root), await generateServiceMd(root));
  });
});

test("generate degrades gracefully on a repo with none of the expected files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-empty-"));
  try {
    const content = await generateServiceMd(root);
    await writeFile(path.join(root, "SERVICE.md"), content);

    const results = await checkServiceMd(root, await readFile(path.join(root, "SERVICE.md"), "utf8"));

    assert.deepEqual(results.filter((r) => r.stale).map((r) => r.id), []);
    assert.match(content, /No \.env\.example found/);
    assert.match(content, /No CI config detected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
