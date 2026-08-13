import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigExistsError, renderStarterConfig, writeStarterConfig } from "../src/core/init.js";
import { CONFIG_FILENAME, parseConfig } from "../src/core/config.js";
import { buildSections } from "../src/core/sections.js";
import { generateServiceMd } from "../src/core/generate.js";

async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-init-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the starter config is valid as written", () => {
  // The whole point of scaffolding: the first generate after init must work,
  // so the example can be edited from a working state rather than a broken one.
  const config = parseConfig(renderStarterConfig());

  assert.equal(config.sections.length, 1);
  assert.equal(config.sections[0].id, "runbook");
  assert.deepEqual(config.exclude, []);
});

test("init writes a config that generate accepts", async () => {
  await withRepo(async (root) => {
    await writeStarterConfig(root);

    const content = await generateServiceMd(root);

    assert.match(content, /## Runbook/);
    assert.match(content, /What to do when this breaks/);
  });
});

test("the starter config's example id is not a built-in", async () => {
  await withRepo(async (root) => {
    const builtInIds = (await buildSections(root)).map((s) => s.id);
    const starterId = parseConfig(renderStarterConfig()).sections[0].id;

    // A collision would make the very first generate after init throw.
    assert.equal(builtInIds.includes(starterId), false);
  });
});

test("init refuses to clobber an existing config", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, CONFIG_FILENAME), '{ "sections": [] }');

    await assert.rejects(() => writeStarterConfig(root), ConfigExistsError);

    assert.equal(await readFile(path.join(root, CONFIG_FILENAME), "utf8"), '{ "sections": [] }');
  });
});

test("--force overwrites deliberately", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, CONFIG_FILENAME), '{ "sections": [] }');

    await writeStarterConfig(root, { force: true });

    assert.match(await readFile(path.join(root, CONFIG_FILENAME), "utf8"), /runbook/);
  });
});

test("init can write to a named file", async () => {
  await withRepo(async (root) => {
    const file = await writeStarterConfig(root, { out: "custom.config.json" });

    assert.equal(file, "custom.config.json");
    assert.match(await readFile(path.join(root, "custom.config.json"), "utf8"), /runbook/);
    assert.match(await generateServiceMd(root, { configPath: "custom.config.json" }), /## Runbook/);
  });
});

test("the written file ends with a newline", async () => {
  await withRepo(async (root) => {
    await writeStarterConfig(root);

    assert.ok((await readFile(path.join(root, CONFIG_FILENAME), "utf8")).endsWith("\n"));
  });
});
