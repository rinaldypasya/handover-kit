import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFiles } from "../src/core/hash.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";

async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-deploy-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function workflow(root: string, name: string, body = "name: ci\n") {
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", name), body);
}

function deployment(results: Awaited<ReturnType<typeof checkServiceMd>>) {
  const found = results.find((r) => r.id === "deployment");
  assert.ok(found, "expected a deployment section");
  return found;
}

test("a directory source hashes its listing, not a missing sentinel", async () => {
  await withRepo(async (root) => {
    const absent = await hashFiles(root, [".github/workflows"]);

    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    const empty = await hashFiles(root, [".github/workflows"]);

    await workflow(root, "deploy.yml");
    const populated = await hashFiles(root, [".github/workflows"]);

    assert.notEqual(absent, empty, "an empty directory is not the same as no directory");
    assert.notEqual(empty, populated);
  });
});

test("a directory hash tracks entry names, not their contents", async () => {
  await withRepo(async (root) => {
    await workflow(root, "deploy.yml", "name: one\n");
    const before = await hashFiles(root, [".github/workflows"]);

    await workflow(root, "deploy.yml", "name: two\n");
    const after = await hashFiles(root, [".github/workflows"]);

    // Contents are covered because the file is itself a listed source; the
    // directory's job is noticing files that weren't there before.
    assert.equal(before, after);
  });
});

test("adding the repo's first workflow registers as drift", async () => {
  await withRepo(async (root) => {
    // The gap this closes: sources recorded at generate time were two absent
    // paths, and adding a workflow afterwards changed neither of them.
    const content = await generateServiceMd(root);
    assert.match(content, /No CI config detected/);

    await workflow(root, "deploy.yml");

    assert.equal(deployment(await checkServiceMd(root, content)).stale, true);
  });
});

test("adding a second workflow to an existing pipeline registers as drift", async () => {
  await withRepo(async (root) => {
    await workflow(root, "ci.yml");
    const content = await generateServiceMd(root);

    await workflow(root, "deploy.yml");

    assert.equal(deployment(await checkServiceMd(root, content)).stale, true);
  });
});

test("removing a workflow registers as drift", async () => {
  await withRepo(async (root) => {
    await workflow(root, "ci.yml");
    await workflow(root, "deploy.yml");
    const content = await generateServiceMd(root);

    await rm(path.join(root, ".github", "workflows", "deploy.yml"));

    assert.equal(deployment(await checkServiceMd(root, content)).stale, true);
  });
});

test("editing a workflow's contents still registers as drift", async () => {
  await withRepo(async (root) => {
    await workflow(root, "ci.yml", "name: ci\n");
    const content = await generateServiceMd(root);

    await workflow(root, "ci.yml", "name: ci\njobs: {}\n");

    assert.equal(deployment(await checkServiceMd(root, content)).stale, true);
  });
});

test("adding .gitlab-ci.yml to a repo with no CI registers as drift", async () => {
  await withRepo(async (root) => {
    const content = await generateServiceMd(root);

    await writeFile(path.join(root, ".gitlab-ci.yml"), "stages: [test]\n");

    assert.equal(deployment(await checkServiceMd(root, content)).stale, true);
  });
});

test("Deployment records both CI roots even when neither exists", async () => {
  await withRepo(async (root) => {
    const sources = deployment(await checkServiceMd(root, await generateServiceMd(root))).sources;

    assert.deepEqual(sources, [".github/workflows", ".gitlab-ci.yml"]);
  });
});

test("an untouched repo with CI stays quiet", async () => {
  await withRepo(async (root) => {
    await workflow(root, "ci.yml");
    await writeFile(path.join(root, ".gitlab-ci.yml"), "stages: [test]\n");

    const results = await checkServiceMd(root, await generateServiceMd(root));

    assert.deepEqual(results.filter((r) => r.stale).map((r) => r.id), []);
  });
});
