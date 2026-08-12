# handover-kit

Keep service documentation alive across handovers. `handover-kit` scans a
repo and generates a `SERVICE.md` from things that are actually true —
`.env.example`, `package.json` scripts, CI config, `CODEOWNERS`, TODO/FIXME
markers — and then watches for drift: if a source file changes but the
matching doc section doesn't, it flags the PR/MR instead of letting the
doc quietly go stale.

It's built provider-agnostic from the start: the core engine only touches
the local filesystem and git history, and platform-specific behavior
(posting a PR/MR comment, reading open issues) goes through a small
`VcsProvider` interface. GitHub and GitLab are implemented; adding another
platform means implementing one interface, not forking the tool.

## Quick start

```bash
npm install
npm run generate   # writes SERVICE.md at the repo root
npm run check       # compares SERVICE.md against its sources, reports drift
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

Run it in CI with `--ci` (non-zero exit on drift, useful as a required
check) and `--post-comment` (posts the report on the PR/MR via whichever
`VcsProvider` matches the CI environment — see `.github/workflows/handover-check.yml`
and `.gitlab-ci.yml` for working examples).

## Project layout

```
src/
  cli.ts                 entry point (generate / check commands)
  core/
    generate.ts           builds SERVICE.md from sections
    check.ts               parses SERVICE.md, recomputes hashes, reports drift
    hash.ts                 the hashing primitive shared by both
    sections.ts              defines each SERVICE.md section + its source files
    parsers/                 small, focused readers: env vars, package.json, CODEOWNERS, CI config, TODOs
  providers/
    VcsProvider.ts          the interface + getProvider() auto-detection
    GithubProvider.ts        posts PR comments / reads issues via GitHub REST API
    GitlabProvider.ts        same contract, via GitLab REST API
```

## Adding a new platform (e.g. Bitbucket)

Implement `VcsProvider` (`postComment`, `getOpenIssues`) in
`src/providers/BitbucketProvider.ts`, then add one branch to `getProvider()`
in `VcsProvider.ts` that detects the right CI environment variable. Nothing
in `core/` needs to change — that's the point of the interface boundary.

## Known limitations (MVP, contributions welcome)

- `generate` currently rewrites the whole file. If you hand-edit the prose
  in a section beyond what was generated, re-running `generate` will
  overwrite it. Splitting sections into an auto-generated part and a
  freeform "notes" part that survives regeneration is the next priority.
- The "Architecture" / dependency-graph section from the original design
  isn't in this MVP yet — `sections.ts` is the place to add it.
- `Known Issues` only scans TODO/FIXME in source files, capped at 500 files
  for speed on large repos; it doesn't yet pull from GitHub/GitLab issues
  even though `VcsProvider.getOpenIssues()` already supports it — wiring
  that in is a good first contribution.
- No test suite yet. Given the hashing logic is the trust-critical part of
  this tool, that's the first thing to add.

## License

MIT
