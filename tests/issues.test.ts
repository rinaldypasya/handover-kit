import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findTodos } from "../src/core/parsers/ci.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";
import { TODO_HEADING, type KnownIssue } from "../src/core/sections.js";

async function withFixtureRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-issues-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "billing-api", description: "Charges people." }, null, 2)
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ISSUES: KnownIssue[] = [
  { title: "Refunds double-charge on retry", url: "https://example.com/issues/2", labels: ["bug", "p1"] },
  { title: "Document the webhook contract", url: "https://example.com/issues/1", labels: [] },
];

function knownIssuesSection(serviceMd: string): string {
  const start = serviceMd.indexOf("## Known Issues");
  assert.notEqual(start, -1, "Known Issues section should exist");
  const next = serviceMd.indexOf("\n## ", start + 1);
  return serviceMd.slice(start, next === -1 ? undefined : next);
}

test("fetched issues are rendered as links with their labels", async () => {
  await withFixtureRepo(async (root) => {
    const body = knownIssuesSection(await generateServiceMd(root, { issues: ISSUES }));

    assert.match(body, /\[Refunds double-charge on retry\]\(https:\/\/example\.com\/issues\/2\)/);
    assert.match(body, /`bug`, `p1`/);
    assert.match(body, /\[Document the webhook contract\]\(https:\/\/example\.com\/issues\/1\)/);
  });
});

test("issue order is stable regardless of what order the API returned", async () => {
  await withFixtureRepo(async (root) => {
    const forwards = await generateServiceMd(root, { issues: ISSUES });
    const backwards = await generateServiceMd(root, { issues: [...ISSUES].reverse() });

    assert.equal(forwards, backwards, "an unstable API order must not rewrite the doc on every run");
  });
});

test("not fetching issues reads differently from finding none", async () => {
  await withFixtureRepo(async (root) => {
    const notFetched = knownIssuesSection(await generateServiceMd(root));
    const fetchedEmpty = knownIssuesSection(await generateServiceMd(root, { issues: [] }));

    // Claiming a clean tracker nobody read is the failure mode worth guarding.
    assert.match(notFetched, /Not fetched/);
    assert.doesNotMatch(notFetched, /No open issues/);
    assert.match(fetchedEmpty, /No open issues/);
  });
});

test("tracker issues never affect drift", async () => {
  await withFixtureRepo(async (root) => {
    const withIssues = await generateServiceMd(root, { issues: ISSUES });

    // The doc was generated against a tracker state that has since changed;
    // nothing in the repo did, so check must stay quiet.
    const results = await checkServiceMd(root, withIssues);

    assert.deepEqual(results.filter((r) => r.stale).map((r) => r.id), []);
    assert.deepEqual(
      results.find((r) => r.id === "known-issues")?.sources,
      ["src/index.ts"],
      "only scanned files belong in the hash"
    );
  });
});

test("both tracker issues and source markers appear together", async () => {
  await withFixtureRepo(async (root) => {
    const marker = "FIX" + "ME";
    await writeFile(path.join(root, "src", "index.ts"), `// ${marker}: handle refunds\nexport const x = 1;\n`);

    const body = knownIssuesSection(await generateServiceMd(root, { issues: ISSUES }));

    assert.match(body, /### From the issue tracker/);
    assert.ok(body.includes(TODO_HEADING));
    assert.match(body, /Refunds double-charge/);
    assert.match(body, /src\/index\.ts:1/);
  });
});

test("the code that renders Known Issues doesn't seed phantom markers", async () => {
  // Regression: spelling this section's heading as a literal made handover-kit
  // report its own render code as two outstanding TODOs. The scanner can't tell
  // a markdown heading from a comment marker, so the fix is that the literal
  // never appears in source — which is exactly what this asserts.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const todos = await findTodos(repoRoot, ["src/core/sections.ts", "tests/issues.test.ts"]);

  assert.deepEqual(todos, []);
  assert.match(TODO_HEADING, /in source$/, "the heading still reads as intended at runtime");
});

test("brackets in an issue title can't break out of the link", async () => {
  await withFixtureRepo(async (root) => {
    const issues: KnownIssue[] = [
      { title: "[URGENT] fix [thing]", url: "https://example.com/issues/9", labels: [] },
    ];

    const body = knownIssuesSection(await generateServiceMd(root, { issues }));

    assert.match(body, /- \[\\\[URGENT\\\] fix \\\[thing\\\]\]\(https:\/\/example\.com\/issues\/9\)/);
  });
});

test("issues render underneath the notes block boundary, not inside it", async () => {
  await withFixtureRepo(async (root) => {
    const content = await generateServiceMd(root, { issues: ISSUES });
    const body = knownIssuesSection(content);

    const issueLine = body.indexOf("Refunds double-charge");
    const notesStart = body.indexOf("handoverkit:notes:start");

    assert.ok(issueLine !== -1 && notesStart !== -1);
    assert.ok(issueLine < notesStart, "generated content must stay out of the hand-written block");
  });
});
