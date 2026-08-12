import type { VcsProvider, PrContext, Issue } from "./VcsProvider.js";
import { REPORT_MARKER } from "../marker.js";

/**
 * GitHub implementation. Uses the plain REST API via fetch so we don't
 * need to depend on @octokit/rest just for a few endpoints — keeps the
 * dependency tree light for an MVP. Swap in @octokit/rest later if we
 * need more surface area (checks API, etc).
 *
 * Expects the standard GitHub Actions environment variables:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/repo"), GITHUB_EVENT_PATH for the PR number.
 */
export class GithubProvider implements VcsProvider {
  readonly name = "github";

  private readonly token = process.env.GITHUB_TOKEN ?? "";
  private readonly repo = process.env.GITHUB_REPOSITORY ?? "";
  private readonly apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  async postComment(context: PrContext, body: string): Promise<void> {
    const prNumber = context.id ?? (await this.resolvePrNumberFromEvent());
    if (!prNumber) {
      console.log("[handoverkit] no PR number found, skipping comment. Body was:\n" + body);
      return;
    }
    if (!this.token || !this.repo) {
      console.warn("[handoverkit] GITHUB_TOKEN or GITHUB_REPOSITORY missing, skipping comment.");
      return;
    }

    // Update in place rather than appending. A check that runs on every push
    // would otherwise bury the PR under one identical comment per commit.
    const existingId = await this.findExistingCommentId(prNumber);
    const url = existingId
      ? `${this.apiBase}/repos/${this.repo}/issues/comments/${existingId}`
      : `${this.apiBase}/repos/${this.repo}/issues/${prNumber}/comments`;

    const res = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: this.headers(),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(`GitHub postComment failed: ${res.status} ${await res.text()}`);
    }
  }

  async getOpenIssues(labels: string[] = []): Promise<Issue[]> {
    if (!this.token || !this.repo) return [];
    const labelParam = labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
    const url = `${this.apiBase}/repos/${this.repo}/issues?state=open&per_page=100${labelParam}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    return data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        title: i.title as string,
        url: i.html_url as string,
        labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
      }));
  }

  /** Finds the comment this tool posted previously, identified by the report marker. */
  private async findExistingCommentId(prNumber: number | string): Promise<number | undefined> {
    try {
      const url = `${this.apiBase}/repos/${this.repo}/issues/${prNumber}/comments?per_page=100`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) return undefined;
      const comments = (await res.json()) as any[];
      const mine = comments.filter((c) => typeof c.body === "string" && c.body.includes(REPORT_MARKER));
      return mine.at(-1)?.id;
    } catch {
      // Falling back to a fresh comment is strictly better than failing the job.
      return undefined;
    }
  }

  /** Reads the PR number out of the GitHub Actions event payload, if available. */
  private async resolvePrNumberFromEvent(): Promise<number | undefined> {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) return undefined;
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(eventPath, "utf8");
      const event = JSON.parse(raw);
      return event.pull_request?.number ?? event.number;
    } catch {
      return undefined;
    }
  }
}
