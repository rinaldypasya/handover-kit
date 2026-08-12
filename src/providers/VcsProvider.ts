/**
 * VcsProvider is the abstraction boundary between the core engine
 * (which only knows about files and git history) and whatever hosting
 * platform a team happens to use (GitHub, GitLab, ...).
 *
 * Anything that can be computed from the local git repo or filesystem
 * (diffs, CODEOWNERS, hashing) does NOT belong here on purpose — it stays
 * host-agnostic in core/. This interface only covers the handful of
 * operations that genuinely require calling a remote platform API:
 * posting a comment on a PR/MR, and reading open issues/tickets.
 *
 * Add a new platform by implementing this interface and registering it
 * in getProvider() below — the core engine never needs to change.
 */

export interface Issue {
  title: string;
  url: string;
  labels: string[];
}

export interface PrContext {
  /** Pull request / merge request number, if running in that context. */
  id?: number | string;
}

export interface VcsProvider {
  readonly name: string;

  /** Post (or update) a comment on the current PR/MR. No-op if not in a PR/MR context. */
  postComment(context: PrContext, body: string): Promise<void>;

  /** Fetch open issues/tickets, optionally filtered by label. Used to populate Known Issues. */
  getOpenIssues(labels?: string[]): Promise<Issue[]>;
}

/**
 * Detects which CI/platform we're running under from environment
 * variables and returns the matching provider. Falls back to a
 * NullProvider (safe no-ops) for local runs so `handoverkit check`
 * never crashes on a dev machine.
 */
export async function getProvider(): Promise<VcsProvider> {
  // Credentials are also accepted outside CI so `generate --with-issues` works
  // from a laptop; without this, reading the tracker would only ever be
  // possible from inside a pipeline, which is not where anyone writes docs.
  const hasGithubCreds = Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
  const hasGitlabCreds = Boolean(process.env.GITLAB_TOKEN && process.env.CI_PROJECT_ID);

  if (process.env.GITHUB_ACTIONS === "true" || hasGithubCreds) {
    const { GithubProvider } = await import("./GithubProvider.js");
    return new GithubProvider();
  }
  if (process.env.GITLAB_CI === "true" || hasGitlabCreds) {
    const { GitlabProvider } = await import("./GitlabProvider.js");
    return new GitlabProvider();
  }
  return new NullProvider();
}

class NullProvider implements VcsProvider {
  readonly name = "none";

  async postComment(_context: PrContext, body: string): Promise<void> {
    console.log("[handoverkit] (local run, not posting) comment would be:\n" + body);
  }

  async getOpenIssues(): Promise<Issue[]> {
    return [];
  }
}
