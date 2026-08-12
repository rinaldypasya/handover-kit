import type { VcsProvider, PrContext, Issue } from "./VcsProvider.js";
import { REPORT_MARKER } from "../marker.js";

/**
 * GitLab implementation of the same VcsProvider contract as GithubProvider.
 * Expects the standard GitLab CI environment variables:
 *   GITLAB_TOKEN (a project/CI token with api scope), CI_API_V4_URL,
 *   CI_PROJECT_ID, CI_MERGE_REQUEST_IID.
 *
 * This is intentionally symmetrical to GithubProvider — same two methods,
 * same shape — so the core engine and CLI never need to know which one
 * they're talking to.
 */
export class GitlabProvider implements VcsProvider {
  readonly name = "gitlab";

  private readonly token = process.env.GITLAB_TOKEN ?? "";
  private readonly apiBase = process.env.CI_API_V4_URL ?? "https://gitlab.com/api/v4";
  private readonly projectId = process.env.CI_PROJECT_ID ?? "";

  private headers() {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };
  }

  async postComment(context: PrContext, body: string): Promise<void> {
    const mrIid = context.id ?? process.env.CI_MERGE_REQUEST_IID;
    if (!mrIid) {
      console.log("[handoverkit] no merge request IID found, skipping comment. Body was:\n" + body);
      return;
    }
    if (!this.token || !this.projectId) {
      console.warn("[handoverkit] GITLAB_TOKEN or CI_PROJECT_ID missing, skipping comment.");
      return;
    }

    // Same reasoning as GithubProvider: edit the previous note instead of
    // stacking a new one on every pipeline run.
    const notesBase = `${this.apiBase}/projects/${encodeURIComponent(this.projectId)}/merge_requests/${mrIid}/notes`;
    const existingId = await this.findExistingNoteId(notesBase);

    const res = await fetch(existingId ? `${notesBase}/${existingId}` : notesBase, {
      method: existingId ? "PUT" : "POST",
      headers: this.headers(),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(`GitLab postComment failed: ${res.status} ${await res.text()}`);
    }
  }

  async getOpenIssues(labels: string[] = []): Promise<Issue[]> {
    if (!this.token || !this.projectId) return [];
    const labelParam = labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.projectId)}/issues?state=opened&per_page=100${labelParam}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    return data.map((i) => ({
      title: i.title as string,
      url: i.web_url as string,
      labels: i.labels ?? [],
    }));
  }

  private async findExistingNoteId(notesBase: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${notesBase}?per_page=100`, { headers: this.headers() });
      if (!res.ok) return undefined;
      const notes = (await res.json()) as any[];
      const mine = notes.filter(
        (n) => !n.system && typeof n.body === "string" && n.body.includes(REPORT_MARKER)
      );
      return mine.at(-1)?.id;
    } catch {
      return undefined;
    }
  }
}
