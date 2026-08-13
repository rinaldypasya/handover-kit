import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModuleGraph, parseImportSpecifiers } from "../src/core/parsers/imports.js";
import { generateServiceMd } from "../src/core/generate.js";

async function withRepo(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-lang-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, relative: string, contents: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

function moduleFor(graph: Awaited<ReturnType<typeof buildModuleGraph>>, dir: string) {
  const found = graph.modules.find((m) => m.dir === dir);
  assert.ok(found, `expected a module entry for ${dir}`);
  return found;
}

test("Python import forms are all recognised", () => {
  const source = [
    "import os",
    "import json as j",
    "import collections, itertools",
    "from pathlib import Path",
    "from .sibling import thing",
    "from ..pkg.mod import other",
    "from . import local",
  ].join("\n");

  assert.deepEqual(parseImportSpecifiers(source, "python"), [
    ".",
    "..pkg.mod",
    ".sibling",
    "collections",
    "itertools",
    "json",
    "os",
    "pathlib",
  ]);
});

test("Python patterns are line-anchored, so prose and comments are ignored", () => {
  const source = ['x = "you can import os here"', "# import sys", "y = 1", "import real"].join("\n");

  // Line anchoring rules out both the string literal and the comment — the
  // false-positive class that forces the package.json cross-check on the
  // JavaScript side doesn't arise here.
  assert.deepEqual(parseImportSpecifiers(source, "python"), ["real"]);
});

test("Go single and grouped imports, with and without aliases, are recognised", () => {
  const source = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\tm "github.com/org/repo/internal/db"',
    '\t_ "gopkg.in/yaml.v3"',
    ")",
    "",
    'import "net/http"',
  ].join("\n");

  assert.deepEqual(parseImportSpecifiers(source, "go"), [
    "fmt",
    "github.com/org/repo/internal/db",
    "gopkg.in/yaml.v3",
    "net/http",
  ]);
});

test("Python relative imports become directory edges", async () => {
  await withRepo(async (root) => {
    await write(root, "app/core/service.py", "from ..store.db import connect\n");
    await write(root, "app/store/db.py", "def connect():\n    pass\n");

    const graph = await buildModuleGraph(root, ["app/core/service.py", "app/store/db.py"]);

    assert.deepEqual(moduleFor(graph, "app/core").dependsOn, ["app/store"]);
  });
});

test("a Python import of a sibling module is cohesion, not an edge", async () => {
  await withRepo(async (root) => {
    await write(root, "app/a.py", "from .b import thing\n");
    await write(root, "app/b.py", "thing = 1\n");

    const graph = await buildModuleGraph(root, ["app/a.py", "app/b.py"]);

    assert.deepEqual(moduleFor(graph, "app").dependsOn, []);
  });
});

test("Python absolute imports resolve to in-repo packages", async () => {
  await withRepo(async (root) => {
    await write(root, "app/api/routes.py", "from app.store.db import connect\n");
    await write(root, "app/store/db.py", "def connect():\n    pass\n");

    const graph = await buildModuleGraph(root, ["app/api/routes.py", "app/store/db.py"]);

    assert.deepEqual(moduleFor(graph, "app/api").dependsOn, ["app/store"]);
  });
});

test("Python external imports are counted as neither edge nor package", async () => {
  await withRepo(async (root) => {
    await write(root, "app/main.py", "import os\nimport yaml\nimport requests\n");

    const graph = await buildModuleGraph(root, ["app/main.py"]);

    // `import yaml` ships in the `PyYAML` distribution; guessing that mapping
    // is what this deliberately declines to do.
    assert.deepEqual(graph.packages, []);
    assert.equal(graph.pythonSeen, true);
  });
});

test("Go in-repo imports resolve through the go.mod module path", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, "go.mod"), "module github.com/org/repo\n\ngo 1.22\n");
    await write(root, "cmd/main.go", 'package main\n\nimport "github.com/org/repo/internal/db"\n');
    await write(root, "internal/db/db.go", "package db\n");

    const graph = await buildModuleGraph(root, ["cmd/main.go", "internal/db/db.go"]);

    assert.deepEqual(moduleFor(graph, "cmd").dependsOn, ["internal/db"]);
  });
});

test("Go third-party paths are listed and the standard library is not", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, "go.mod"), "module github.com/org/repo\n");
    await write(
      root,
      "cmd/main.go",
      ["package main", "", "import (", '\t"fmt"', '\t"net/http"', '\t"github.com/spf13/cobra"', ")"].join("\n")
    );

    const graph = await buildModuleGraph(root, ["cmd/main.go"]);

    // A dot in the first segment means a hosted path; stdlib never has one.
    assert.deepEqual(graph.packages, ["github.com/spf13/cobra"]);
  });
});

test("Go imports are not filtered against package.json", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, "go.mod"), "module github.com/org/repo\n");
    await write(root, "cmd/main.go", 'package main\n\nimport "github.com/spf13/cobra"\n');

    const graph = await buildModuleGraph(root, ["cmd/main.go"], ["commander"]);

    assert.deepEqual(graph.packages, ["github.com/spf13/cobra"], "that filter exists for JS name collisions only");
  });
});

test("a polyglot repo reports every language it parsed", async () => {
  await withRepo(async (root) => {
    await write(root, "app/main.py", "import os\n");
    await write(root, "cmd/main.go", "package main\n");
    await write(root, "web/index.ts", "export const x = 1;\n");
    await write(root, "legacy/Thing.java", "import java.util.List;\n");

    const graph = await buildModuleGraph(root, [
      "app/main.py",
      "cmd/main.go",
      "web/index.ts",
      "legacy/Thing.java",
    ]);

    assert.deepEqual(graph.languages, ["go", "javascript", "python"]);
    assert.equal(graph.unparsedCount, 1, "Java is counted, not parsed");
  });
});

test("a Python repo gets a real Architecture table", async () => {
  await withRepo(async (root) => {
    await write(root, "app/api/routes.py", "from app.store.db import connect\n");
    await write(root, "app/store/db.py", "def connect():\n    pass\n");

    const content = await generateServiceMd(root);

    assert.match(content, /\| `app\/api` \| 1 \| `app\/store` \|/);
    assert.match(content, /import name doesn't reliably map to a distribution name/);
  });
});

test("a Go repo gets a real Architecture table", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, "go.mod"), "module github.com/org/repo\n");
    await write(root, "cmd/main.go", 'package main\n\nimport "github.com/org/repo/internal/db"\n');
    await write(root, "internal/db/db.go", "package db\n");

    const content = await generateServiceMd(root);

    assert.match(content, /\| `cmd` \| 1 \| `internal\/db` \|/);
  });
});

test("Go without go.mod still lists third-party paths but finds no internal edges", async () => {
  await withRepo(async (root) => {
    await write(root, "cmd/main.go", 'package main\n\nimport (\n\t"github.com/spf13/cobra"\n)\n');
    await write(root, "internal/db/db.go", "package db\n");

    const graph = await buildModuleGraph(root, ["cmd/main.go", "internal/db/db.go"]);

    assert.deepEqual(graph.packages, ["github.com/spf13/cobra"]);
    assert.deepEqual(moduleFor(graph, "cmd").dependsOn, [], "nothing tells us which paths are in-repo");
  });
});
