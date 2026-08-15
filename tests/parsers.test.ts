import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnvFile } from "../src/core/parsers/env.js";
import { parseCodeowners } from "../src/core/parsers/codeowners.js";
import { detectCi, findTodos } from "../src/core/parsers/ci.js";
import { listSourceFiles } from "../src/core/parsers/walk.js";

async function withTempRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-parse-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("env parser keeps the comment above a variable as its description", () => {
  const vars = parseEnvFile("# Port the server listens on\nPORT=3000\n");
  assert.deepEqual(vars, [{ name: "PORT", defaultValue: "3000", comment: "Port the server listens on" }]);
});

test("env parser treats a variable with no value as having no default", () => {
  const [v] = parseEnvFile("API_KEY=\n");
  assert.equal(v.defaultValue, undefined);
});

test("env parser strips quotes and trailing inline comments", () => {
  const vars = parseEnvFile(['NAME="handover kit" # the service', "MODE=debug # noisy"].join("\n"));
  assert.equal(vars[0].defaultValue, "handover kit");
  assert.equal(vars[1].defaultValue, "debug");
});

test("env parser does not truncate values containing a bare #", () => {
  const [v] = parseEnvFile("DATABASE_URL=postgres://user:pa#ss@localhost:5432/db\n");
  assert.equal(v.defaultValue, "postgres://user:pa#ss@localhost:5432/db");
});

test("env parser understands `export FOO=bar`", () => {
  const [v] = parseEnvFile("export REDIS_URL=redis://localhost:6379\n");
  assert.equal(v.name, "REDIS_URL");
  assert.equal(v.defaultValue, "redis://localhost:6379");
});

test("env parser does not attach a comment separated by a blank line", () => {
  const [v] = parseEnvFile("# unrelated note\n\nPORT=3000\n");
  assert.equal(v.comment, undefined);
});

test("codeowners parser strips trailing comments and ownerless lines", () => {
  const entries = parseCodeowners(["# header", "src/core/  @alice @bob # core team", "docs/", ""].join("\n"));
  assert.deepEqual(entries, [{ pattern: "src/core/", owners: ["@alice", "@bob"] }]);
});

test("detectCi reports every CI system present, not just the first", async () => {
  await withTempRepo(async (root) => {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
    await writeFile(path.join(root, ".gitlab-ci.yml"), "stages: [test]\n");

    const ci = await detectCi(root);

    assert.deepEqual(
      ci.systems.map((s) => s.kind).sort(),
      ["github-actions", "gitlab-ci"]
    );
    assert.deepEqual(ci.files, [".github/workflows/ci.yml", ".gitlab-ci.yml"]);
  });
});

test("detectCi reports nothing for a repo with no pipelines", async () => {
  await withTempRepo(async (root) => {
    const ci = await detectCi(root);
    assert.deepEqual(ci.systems, []);
    assert.deepEqual(ci.files, []);
  });
});

// Built at runtime rather than written literally: a fixture containing a real
// marker would be picked up by handover-kit's own scan of this repo and land in
// SERVICE.md's Known Issues as if it were a genuine outstanding task.
const TODO = "TO" + "DO";
const FIXME = "FIX" + "ME";

test("findTodos requires a real comment marker before the keyword", async () => {
  await withTempRepo(async (root) => {
    await writeFile(
      path.join(root, "a.ts"),
      [`// ${TODO}: wire up retries`, `const re = /(${TODO}|${FIXME})/;`, `const label = "${TODO} list";`].join("\n")
    );

    const todos = await findTodos(root, ["a.ts"]);

    assert.equal(todos.length, 1);
    assert.equal(todos[0].line, 1);
    assert.equal(todos[0].text, "wire up retries");
  });
});

test("listSourceFiles returns a deterministic, posix-separated listing", async () => {
  await withTempRepo(async (root) => {
    await mkdir(path.join(root, "src", "core"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "zebra.ts"), "");
    await writeFile(path.join(root, "apple.ts"), "");
    await writeFile(path.join(root, "notes.md"), "");
    await writeFile(path.join(root, "src", "core", "hash.ts"), "");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "");

    const files = await listSourceFiles(root);

    // Sorted as a whole rather than in walk order: the selection is spread
    // across directories now, so walk order is no longer the output order.
    assert.deepEqual(files, ["apple.ts", "src/core/hash.ts", "zebra.ts"]);
    assert.deepEqual(files, await listSourceFiles(root), "repeated walks must agree");
  });
});

test("listSourceFiles honours its cap", async () => {
  await withTempRepo(async (root) => {
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(root, `f${i}.ts`), "");
    }
    assert.equal((await listSourceFiles(root, 4)).length, 4);
  });
});
