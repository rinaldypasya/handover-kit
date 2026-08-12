# handover-kit

Keep service documentation alive across handovers. `handover-kit` scans a
repo and generates a `SERVICE.md` from things that are actually true —
`.env.example`, `package.json` scripts, CI config, `CODEOWNERS`, TODO/FIXME
markers — and then watches for drift: if a source file changes but the
matching doc section doesn't, it flags the PR/MR instead of letting the
doc quietly go stale.

It's built provider-agnostic from the start: the core engine only touches
the local filesystem, and platform-specific behavior (posting a PR/MR
comment, reading open issues) goes through a small `VcsProvider` interface.
GitHub and GitLab are implemented; adding another platform means
implementing one interface, not forking the tool.

## Quick start

```bash
npm install
npm run generate   # writes SERVICE.md at the repo root
npm run check      # compares SERVICE.md against its sources, reports drift
```

Development:

```bash
npm test        # node:test suite — no extra test runner dependency
npm run typecheck
npm run build
```

## How drift detection works

Every section in `SERVICE.md` gets a hidden metadata comment recording a
hash of the files it was generated from:

```markdown
## Environment & Config
<!-- handoverkit:id=environment hash=3f9a21c40b1e sources=.env.example -->
| Variable | Default | Notes |
...
```

`handoverkit check` recomputes each hash from the same source files and
compares it to what's stored. If they differ, that section is stale. This
is deliberately not LLM-based — it's a plain hash comparison, so there are
no false positives from a model "deciding" something looks fine.

A missing file hashes to a fixed sentinel rather than being skipped, so
"the file used to exist and now doesn't" also counts as drift. Paths are
normalised to `/` and directory walks are explicitly sorted, so a hash
generated on one machine matches the one recomputed in CI.

Run it in CI with `--ci` (non-zero exit on drift, useful as a required
check) and `--post-comment` (posts the report on the PR/MR via whichever
`VcsProvider` matches the CI environment — see `.github/workflows/handover-check.yml`
and `.gitlab-ci.yml` for working examples). The comment carries a hidden
marker, so repeat runs edit the existing comment instead of stacking a new
one on every push.

## The Architecture section

`Architecture` answers "what talks to what" by grouping scanned files per
directory and deriving edges from their relative imports:

```markdown
| Directory | Files | Imports from |
| --- | --- | --- |
| `src` | 2 | `src/core`, `src/providers` |
| `src/core` | 5 | `src/core/parsers` |
| `src/core/parsers` | 7 | _(nothing internal)_ |
```

Directory granularity is deliberate — a per-file graph of a real service is
unreadable, and a handover needs the shape, not the wiring. Imports within one
directory aren't edges, so the table shows coupling rather than cohesion.

Because it's derived from the same scanned files the hash covers, deleting a
dependency edge shows up as drift on this section.

## Pulling in open issues

`Known Issues` lists TODO/FIXME markers found in source. It can also list
open tickets from the tracker:

```bash
handoverkit generate --with-issues
handoverkit generate --with-issues --issue-labels bug,p1
```

Credentials come from the environment — `GITHUB_TOKEN` + `GITHUB_REPOSITORY`,
or `GITLAB_TOKEN` + `CI_PROJECT_ID`. Both work outside CI, so you can run this
from a laptop; without them the fetch is skipped with a warning.

Tickets are **not** part of the section hash, and that's deliberate. Nothing
in the repo changes when somebody opens an issue, so hashing them would make
`check` depend on a remote system and report drift on commits that changed
nothing. The trade-off is the one listed under limitations: the ticket list is
a snapshot from the last `generate`.

A tracker that wasn't read renders as *"Not fetched"*, never as *"No open
issues"* — the doc shouldn't claim a clean tracker nobody looked at.

## Hand-written notes survive regeneration

Everything a section renders is derived from source files, so `generate`
rewrites it on every run. The things that make a handover actually useful —
why the connection pool is capped, who to call at 3am, which migration is
load-bearing — aren't recoverable from the filesystem, so they get a
protected block instead:

```markdown
## Environment & Config
<!-- handoverkit:id=environment hash=3f9a21c40b1e sources=.env.example -->
| Variable | Default | Notes |
...

<!-- handoverkit:notes:start id=environment -->
Postgres runs on the shared cluster — ask #infra before touching the pool size.
<!-- handoverkit:notes:end id=environment -->
```

`generate` reads the file it's about to overwrite and copies each block
across verbatim. Write plain markdown in there; it's yours.

Notes are not part of the hash — the hash tracks source files, so editing
your own prose never marks a section as drifted.

Two rules keep this from losing text:

- The closing marker must repeat the same `id`. Otherwise a block missing
  its end tag would silently swallow the next section.
- If a block is opened and never closed, `generate` aborts with an error
  instead of guessing where your prose ended.

Notes whose section no longer exists (a renamed id, an edited `sections.ts`)
are parked under an `Unfiled Notes` heading rather than dropped.

## Project layout

```
src/
  cli.ts                 entry point (generate / check commands)
  marker.ts              the marker embedded in reports, so comments update in place
  core/
    generate.ts           builds SERVICE.md from sections
    notes.ts               carries hand-written notes blocks across regeneration
    check.ts               parses SERVICE.md, recomputes hashes, reports drift
    hash.ts                 the hashing primitive shared by both
    sections.ts              defines each SERVICE.md section + its source files
    parsers/                 small, focused readers: env vars, package.json, CODEOWNERS, CI config, TODOs, imports
  providers/
    VcsProvider.ts          the interface + getProvider() auto-detection
    GithubProvider.ts        posts PR comments / reads issues via GitHub REST API
    GitlabProvider.ts        same contract, via GitLab REST API
tests/                    node:test suite covering hashing, parsers, and generate→check round-trips
```

## Adding a new platform (e.g. Bitbucket)

Implement `VcsProvider` (`postComment`, `getOpenIssues`) in
`src/providers/BitbucketProvider.ts`, then add one branch to `getProvider()`
in `VcsProvider.ts` that detects the right CI environment variable. Nothing
in `core/` needs to change — that's the point of the interface boundary.

## Known limitations (MVP, contributions welcome)

- Prose is only protected inside a notes block. Text you type into the
  generated half of a section is still overwritten on the next run.
- `Architecture` reads imports with regexes rather than a parser, so a
  specifier sitting inside a string or comment counts as an import. Package
  names are cross-checked against `package.json` to keep that out of the
  output, which means a package imported but never declared won't be listed.
  Non-JavaScript files are counted but not parsed for imports.
- `Known Issues` scans TODO/FIXME in at most 200 source files, for speed on
  large repos.
- Issues pulled with `--with-issues` are a snapshot. They're written into the
  doc but not hashed, so the doc can describe a closed ticket until someone
  regenerates.
- The Deployment section hashes the CI files it found. If a repo had *no*
  CI and someone adds `.github/workflows/deploy.yml`, that specific case
  isn't detected as drift (a new `.gitlab-ci.yml` is). Hashing a directory
  listing rather than a fixed path list would close the gap.
- Adding or removing any scanned source file changes the Known Issues hash,
  so that section goes stale more eagerly than the others.

## License

MIT — see [LICENSE](LICENSE).
