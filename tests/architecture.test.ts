import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModuleGraph, parseImportSpecifiers } from "../src/core/parsers/imports.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";

/** A repo with a real shape: cli -> core -> core/parsers, plus a package import. */
async function withLayeredRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-arch-"));
  try {
    await mkdir(path.join(root, "src", "core", "parsers"), { recursive: true });
    await writeFile(
      path.join(root, "src", "cli.ts"),
      ['import { Command } from "commander";', 'import { run } from "./core/engine.js";', "run(new Command());"].join("\n")
    );
    await writeFile(
      path.join(root, "src", "core", "engine.ts"),
      ['import { parse } from "./parsers/env.js";', 'import { readFile } from "node:fs/promises";', "export const run = parse;"].join("\n")
    );
    await writeFile(path.join(root, "src", "core", "parsers", "env.ts"), "export const parse = () => 1;\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function moduleFor(graph: Awaited<ReturnType<typeof buildModuleGraph>>, dir: string) {
  const found = graph.modules.find((m) => m.dir === dir);
  assert.ok(found, `expected a module entry for ${dir}`);
  return found;
}

test("parseImportSpecifiers covers the four ways to name a module", () => {
  const source = [
    'import a from "static";',
    'import "side-effect";',
    'export { b } from "re-export";',
    'const c = await import("dynamic");',
    'const d = require("commonjs");',
  ].join("\n");

  assert.deepEqual(parseImportSpecifiers(source), [
    "commonjs",
    "dynamic",
    "re-export",
    "side-effect",
    "static",
  ]);
});

test("multi-line import statements are picked up", () => {
  const source = 'import {\n  a,\n  b,\n} from "./wrapped.js";\n';

  assert.deepEqual(parseImportSpecifiers(source), ["./wrapped.js"]);
});

test("relative imports become edges between directories", async () => {
  await withLayeredRepo(async (root) => {
    const graph = await buildModuleGraph(root, ["src/cli.ts", "src/core/engine.ts", "src/core/parsers/env.ts"]);

    assert.deepEqual(moduleFor(graph, "src").dependsOn, ["src/core"]);
    assert.deepEqual(moduleFor(graph, "src/core").dependsOn, ["src/core/parsers"]);
    assert.deepEqual(moduleFor(graph, "src/core/parsers").dependsOn, []);
  });
});

test("file counts are per directory", async () => {
  await withLayeredRepo(async (root) => {
    const graph = await buildModuleGraph(root, ["src/cli.ts", "src/core/engine.ts", "src/core/parsers/env.ts"]);

    assert.equal(moduleFor(graph, "src").fileCount, 1);
    assert.equal(moduleFor(graph, "src/core").fileCount, 1);
  });
});

test("a directory importing itself produces no edge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-self-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), 'import { b } from "./b.js";\n');
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");

    const graph = await buildModuleGraph(root, ["src/a.ts", "src/b.ts"]);

    assert.deepEqual(moduleFor(graph, "src").dependsOn, [], "cohesion within a directory isn't an edge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packages are listed but Node builtins are not", async () => {
  await withLayeredRepo(async (root) => {
    const graph = await buildModuleGraph(root, ["src/cli.ts", "src/core/engine.ts", "src/core/parsers/env.ts"]);

    assert.deepEqual(graph.packages, ["commander"], "node:fs/promises is not a dependency worth documenting");
  });
});

test("package subpaths and scopes collapse to the installed name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-pkg-"));
  try {
    await writeFile(
      path.join(root, "a.ts"),
      ['import x from "lodash/merge";', 'import y from "@scope/pkg/deep/path";', 'import z from "fs";'].join("\n")
    );

    const graph = await buildModuleGraph(root, ["a.ts"]);

    assert.deepEqual(graph.packages, ["@scope/pkg", "lodash"], "bare 'fs' is still a builtin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files in an unsupported language are counted, not parsed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-poly-"));
  try {
    // JavaScript, Python and Go are parsed; see tests/languages.test.ts. Ruby
    // is counted so the section can say how much it couldn't read.
    await writeFile(path.join(root, "legacy.rb"), 'require "json"\n');
    await writeFile(path.join(root, "app.ts"), "export const x = 1;\n");

    const graph = await buildModuleGraph(root, ["app.ts", "legacy.rb"]);

    assert.equal(graph.unparsedCount, 1);
    assert.deepEqual(graph.packages, [], "a Ruby require must not leak in as an npm package");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the graph is ordered deterministically regardless of input order", async () => {
  await withLayeredRepo(async (root) => {
    const files = ["src/cli.ts", "src/core/engine.ts", "src/core/parsers/env.ts"];

    const forwards = await buildModuleGraph(root, files);
    const backwards = await buildModuleGraph(root, [...files].reverse());

    assert.deepEqual(forwards, backwards);
  });
});

test("packages are filtered to what package.json declares", async () => {
  await withLayeredRepo(async (root) => {
    // The fixture imports "commander" for real; this line is the kind of string
    // literal that used to be mistaken for a dependency.
    await writeFile(path.join(root, "src", "core", "note.ts"), 'const example = \'import x from "lodash";\';\nexport default example;\n');
    const files = ["src/cli.ts", "src/core/engine.ts", "src/core/note.ts", "src/core/parsers/env.ts"];

    const unfiltered = await buildModuleGraph(root, files);
    const filtered = await buildModuleGraph(root, files, ["commander"]);

    assert.deepEqual(unfiltered.packages, ["commander", "lodash"], "the regex genuinely cannot tell these apart");
    assert.deepEqual(filtered.packages, ["commander"]);
  });
});

test("a repo without package.json lists packages unfiltered rather than none", async () => {
  await withLayeredRepo(async (root) => {
    const content = await generateServiceMd(root);

    assert.match(content, /External packages imported: `commander`\./);
  });
});

test("the Architecture section renders the graph into SERVICE.md", async () => {
  await withLayeredRepo(async (root) => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "svc", dependencies: { commander: "^12.0.0" } })
    );

    const content = await generateServiceMd(root);

    assert.match(content, /## Architecture/);
    assert.match(content, /\| Directory \| Files \| Imports from \|/);
    assert.match(content, /External packages imported: `commander`\./);
  });
});

test("changing an import marks Architecture as drifted", async () => {
  await withLayeredRepo(async (root) => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    const content = await generateServiceMd(root);

    await writeFile(path.join(root, "src", "core", "engine.ts"), "export const run = () => 1;\n");

    const results = await checkServiceMd(root, content);
    const architecture = results.find((r) => r.id === "architecture");

    assert.equal(architecture?.stale, true, "a dropped dependency edge is exactly what this section documents");
  });
});

test("a repo with no source files says so instead of rendering an empty table", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-bare-"));
  try {
    const content = await generateServiceMd(root);

    assert.match(content, /## Architecture/);
    assert.match(content, /nothing to map here/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
