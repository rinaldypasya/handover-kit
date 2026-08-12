import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFiles } from "../src/core/hash.js";

async function withTempRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-hash-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("hash is independent of the order sources are listed in", async () => {
  await withTempRepo(async (root) => {
    await writeFile(path.join(root, "a.txt"), "alpha");
    await writeFile(path.join(root, "b.txt"), "beta");

    const forward = await hashFiles(root, ["a.txt", "b.txt"]);
    const reverse = await hashFiles(root, ["b.txt", "a.txt"]);

    assert.equal(forward, reverse);
  });
});

test("hash changes when a source file's contents change", async () => {
  await withTempRepo(async (root) => {
    await writeFile(path.join(root, "a.txt"), "alpha");
    const before = await hashFiles(root, ["a.txt"]);

    await writeFile(path.join(root, "a.txt"), "alpha!");
    const after = await hashFiles(root, ["a.txt"]);

    assert.notEqual(before, after);
  });
});

test("a deleted source file registers as drift rather than silently matching", async () => {
  await withTempRepo(async (root) => {
    await writeFile(path.join(root, "a.txt"), "alpha");
    const present = await hashFiles(root, ["a.txt"]);

    await rm(path.join(root, "a.txt"));
    const missing = await hashFiles(root, ["a.txt"]);

    assert.notEqual(present, missing);
  });
});

test("file paths are part of the hash, so a rename is drift", async () => {
  await withTempRepo(async (root) => {
    await writeFile(path.join(root, "a.txt"), "same contents");
    await writeFile(path.join(root, "b.txt"), "same contents");

    assert.notEqual(await hashFiles(root, ["a.txt"]), await hashFiles(root, ["b.txt"]));
  });
});

test("hashing no sources is stable and does not throw", async () => {
  await withTempRepo(async (root) => {
    assert.equal(await hashFiles(root, []), await hashFiles(root, []));
  });
});

test("a directory listed as a source hashes as missing rather than throwing", async () => {
  await withTempRepo(async (root) => {
    const hash = await hashFiles(root, [".github/workflows"]);
    assert.match(hash, /^[0-9a-f]{12}$/);
  });
});
