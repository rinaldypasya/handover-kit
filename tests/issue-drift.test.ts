import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkServiceMd,
  compareDocumentedIssues,
  extractDocumentedIssueUrls,
  formatIssueNote,
} from "../src/core/check.js";
import { generateServiceMd } from "../src/core/generate.js";
import type { KnownIssue } from "../src/core/sections.js";

async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-idrift-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const issue = (n: number, title = `Issue ${n}`): KnownIssue => ({
  title,
  url: `https://example.com/issues/${n}`,
  labels: [],
});

test("a doc generated without --with-issues records no ticket list", async () => {
  await withRepo(async (root) => {
    assert.equal(extractDocumentedIssueUrls(await generateServiceMd(root)), undefined);
  });
});

test("a doc generated with issues records exactly those URLs", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root, { issues: [issue(2), issue(1)] });

    assert.deepEqual(extractDocumentedIssueUrls(content), [
      "https://example.com/issues/1",
      "https://example.com/issues/2",
    ]);
  });
});

test("an empty tracker records an empty list, distinct from never asking", async () => {
  await withRepo(async (root) => {
    const fetched = await generateServiceMd(root, { issues: [] });
    const notFetched = await generateServiceMd(root);

    assert.deepEqual(extractDocumentedIssueUrls(fetched), []);
    assert.equal(extractDocumentedIssueUrls(notFetched), undefined);
  });
});

test("the marker is invisible to drift parsing and to the notes blocks", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root, { issues: [issue(1)] });
    const results = await checkServiceMd(root, content);

    assert.deepEqual(results.filter((r) => r.stale), [], "a ticket list must never move the hash");
    assert.equal(results.some((r) => r.id === "issues"), false);
  });
});

test("regenerating with the same tickets is byte-identical", async () => {
  await withRepo(async (root) => {
    const once = await generateServiceMd(root, { issues: [issue(1), issue(2)] });
    const twice = await generateServiceMd(root, { previous: once, issues: [issue(2), issue(1)] });

    assert.equal(once, twice);
  });
});

test("closed tickets are the ones documented but no longer open", () => {
  const comparison = compareDocumentedIssues(
    ["https://example.com/issues/1", "https://example.com/issues/2"],
    [issue(2)]
  );

  assert.deepEqual(comparison.closed, ["https://example.com/issues/1"]);
  assert.deepEqual(comparison.missing, []);
});

test("missing tickets are the ones open but undocumented", () => {
  const comparison = compareDocumentedIssues(["https://example.com/issues/1"], [issue(1), issue(3)]);

  assert.deepEqual(comparison.closed, []);
  assert.deepEqual(comparison.missing.map((i) => i.url), ["https://example.com/issues/3"]);
});

test("an unchanged tracker compares clean", () => {
  const comparison = compareDocumentedIssues(["https://example.com/issues/1"], [issue(1)]);

  assert.deepEqual(comparison, { closed: [], missing: [] });
  assert.match(formatIssueNote(comparison), /still matches the tracker/);
});

test("the note says plainly that it doesn't fail the check", () => {
  const note = formatIssueNote(compareDocumentedIssues(["https://example.com/issues/1"], []));

  assert.match(note, /does not fail the check/);
  assert.match(note, /no longer open/);
  assert.match(note, /generate --with-issues/);
});

test("the note reports both directions at once", () => {
  const note = formatIssueNote(
    compareDocumentedIssues(["https://example.com/issues/1"], [issue(2, "Newly opened")])
  );

  assert.match(note, /1 ticket listed in SERVICE\.md is no longer open/);
  assert.match(note, /1 open ticket isn't in SERVICE\.md/);
  assert.match(note, /\[Newly opened\]\(https:\/\/example\.com\/issues\/2\)/);
});

test("long lists are truncated rather than flooding a PR comment", () => {
  const documented = Array.from({ length: 14 }, (_, i) => `https://example.com/issues/${i + 1}`);

  const note = formatIssueNote(compareDocumentedIssues(documented, []));

  assert.match(note, /14 tickets listed in SERVICE\.md are no longer open/);
  assert.match(note, /_\(4 more\)_/);
});

test("brackets in a missing ticket's title can't break out of the link", () => {
  const note = formatIssueNote(compareDocumentedIssues([], [issue(9, "[URGENT] thing")]));

  assert.match(note, /\[\\\[URGENT\\\] thing\]\(https:\/\/example\.com\/issues\/9\)/);
});
