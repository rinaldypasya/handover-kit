import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_FILENAME, parseConfig } from "../src/core/config.js";
import { generateServiceMd } from "../src/core/generate.js";
import { checkServiceMd } from "../src/core/check.js";
import { extractNotes } from "../src/core/notes.js";

async function withRepo(config: unknown, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "handoverkit-config-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc" }));
    await mkdir(path.join(root, "ops"), { recursive: true });
    await writeFile(path.join(root, "ops", "rota.yml"), "oncall: alice\n");
    if (config !== undefined) {
      await writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify(config, null, 2));
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ROTA = { id: "oncall", title: "On-call Rota", sources: ["ops/rota.yml"] };

function ids(content: string) {
  return [...content.matchAll(/handoverkit:id=(\S+)/g)].map((m) => m[1]);
}

test("a repo with no config file generates the built-in sections", async () => {
  await withRepo(undefined, async (root) => {
    assert.deepEqual(ids(await generateServiceMd(root)), [
      "overview",
      "architecture",
      "environment",
      "local-setup",
      "deployment",
      "known-issues",
      "ownership",
    ]);
  });
});

test("a custom section is appended and tracked for drift", async () => {
  await withRepo({ sections: [ROTA] }, async (root) => {
    const content = await generateServiceMd(root);
    assert.match(content, /## On-call Rota/);
    assert.deepEqual(
      (await checkServiceMd(root, content)).filter((r) => r.stale),
      []
    );

    await writeFile(path.join(root, "ops", "rota.yml"), "oncall: bob\n");

    const drifted = (await checkServiceMd(root, content)).find((r) => r.id === "oncall");
    assert.equal(drifted?.stale, true);
  });
});

test("a custom section gets a notes block like any other", async () => {
  await withRepo({ sections: [ROTA] }, async (root) => {
    assert.ok(extractNotes(await generateServiceMd(root)).has("oncall"));
  });
});

test("editing the config re-baselines the sections it defines", async () => {
  await withRepo({ sections: [ROTA] }, async (root) => {
    const content = await generateServiceMd(root);

    // The section now tracks a second file. Nothing on disk changed, but what
    // this section is *about* did, so it has to be regenerated.
    await writeFile(
      path.join(root, CONFIG_FILENAME),
      JSON.stringify({ sections: [{ ...ROTA, sources: ["ops/rota.yml", "ops/escalation.md"] }] })
    );

    assert.equal((await checkServiceMd(root, content)).find((r) => r.id === "oncall")?.stale, true);
  });
});

test("a static body renders, and omitting it leaves a prompt to write one", async () => {
  await withRepo({ sections: [{ ...ROTA, body: "Rotates Mondays. See `ops/rota.yml`." }] }, async (root) => {
    assert.match(await generateServiceMd(root), /Rotates Mondays/);
  });

  await withRepo({ sections: [ROTA] }, async (root) => {
    assert.match(await generateServiceMd(root), /write what matters in the notes block/);
  });
});

test("exclude drops a built-in section", async () => {
  await withRepo({ exclude: ["known-issues", "architecture"] }, async (root) => {
    const rendered = ids(await generateServiceMd(root));

    assert.equal(rendered.includes("known-issues"), false);
    assert.equal(rendered.includes("architecture"), false);
    assert.equal(rendered.includes("overview"), true);
  });
});

test("order pulls named sections to the front and leaves the rest alone", async () => {
  await withRepo({ sections: [ROTA], order: ["oncall", "ownership"] }, async (root) => {
    const rendered = ids(await generateServiceMd(root));

    assert.deepEqual(rendered.slice(0, 2), ["oncall", "ownership"]);
    assert.deepEqual(rendered.slice(2), ["overview", "architecture", "environment", "local-setup", "deployment", "known-issues"]);
  });
});

test("a custom id colliding with a built-in is rejected", async () => {
  await withRepo({ sections: [{ ...ROTA, id: "overview" }] }, async (root) => {
    await assert.rejects(() => generateServiceMd(root), /already a built-in section/);
  });
});

test("excluding a section that doesn't exist is an error, not a no-op", async () => {
  await withRepo({ exclude: ["known-isues"] }, async (root) => {
    await assert.rejects(() => generateServiceMd(root), /isn't a built-in section/);
  });
});

test("ordering an unknown section is an error", async () => {
  await withRepo({ order: ["nope"] }, async (root) => {
    await assert.rejects(() => generateServiceMd(root), /neither a built-in nor a configured section/);
  });
});

test("an explicitly requested config file that is missing is an error", async () => {
  await withRepo(undefined, async (root) => {
    await assert.rejects(
      () => generateServiceMd(root, { configPath: "nope.json" }),
      /Config file not found: nope\.json/
    );
  });
});

test("malformed JSON names the file rather than throwing a bare SyntaxError", () => {
  assert.throws(() => parseConfig("{ nope", "my.json"), /my\.json is not valid JSON/);
});

test("an id outside the marker charset is rejected", () => {
  // Ids are embedded in the HTML comments driving drift and notes carry-over;
  // one containing a space or "-->" would corrupt the document.
  assert.throws(() => parseConfig(JSON.stringify({ sections: [{ ...ROTA, id: "on call" }] })), /only letters, digits/);
  assert.throws(() => parseConfig(JSON.stringify({ sections: [{ ...ROTA, id: "a-->b" }] })), /only letters, digits/);
});

test("duplicate custom ids are rejected", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [ROTA, ROTA] })),
    /duplicates an earlier section id/
  );
});

test("sources escaping the repo are rejected", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [{ ...ROTA, sources: ["../../etc/passwd"] }] })),
    /escapes it with "\.\."/
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [{ ...ROTA, sources: ["/etc/passwd"] }] })),
    /must be repo-relative/
  );
});

test("a section with no sources is rejected", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [{ id: "x", title: "X", sources: [] }] })),
    /must list at least one file or directory/
  );
});

test("a misspelled key is reported instead of silently ignored", () => {
  assert.throws(() => parseConfig(JSON.stringify({ section: [] })), /unknown key "section"/);
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [{ ...ROTA, sourcess: [] }] })),
    /unknown key "sourcess"/
  );
});

test("a multi-line title is rejected before it can break the heading", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ sections: [{ ...ROTA, title: "On-call\n## Injected" }] })),
    /must be a single line/
  );
});
