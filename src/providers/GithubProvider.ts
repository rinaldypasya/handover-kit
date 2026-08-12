import type { VcsProvider, PrContext, Issue } from "./VcsProvider.js";

/**
 * GitHub implementation. Uses the plain REST API via fetch so we don't
 * need to depend on @octokit/rest just for two endpoints — keeps the
 * dependency tree light for an MVP. Swap in @octokit/rest later if we
 * need more surface area (checks API, etc).
 *
 * Expects the standard GitHub Actions environment variables:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/repo"), GITHUB_REF / event payload for PR number.
 */
export class GithubProvider implements VcsProvider {
  readonly name = "github";

  private readonly token = process.env.GITHUB_TOKEN ?? "";
  private readonly repo = process.env.GITHUB_REPOSITORY ?? "";

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
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
    const url = `https://api.github.com/repos/${this.repo}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: "POST",
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
    const url = `https://api.github.com/repos/${this.repo}/issues?state=open${labelParam}`;
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
