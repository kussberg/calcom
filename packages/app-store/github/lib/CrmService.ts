import z from "zod";

import logger from "@calcom/lib/logger";
import type { CalendarEvent, CalEventResponses } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { CRM, ContactCreateInput, CrmEvent, Contact } from "@calcom/types/CrmService";

const credentialSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
});

export default class GitHubCrmService implements CRM {
  private accessToken: string;
  private log: typeof logger;

  constructor(credential: CredentialPayload) {
    this.log = logger.getSubLogger({ prefix: ["[lib] github_crm"] });

    const parsedKey = credentialSchema.safeParse(credential.key);

    if (!parsedKey.success) {
      throw new Error(
        `Invalid credentials for userId ${credential.userId} and appId ${credential.appId}: ${parsedKey.error}`
      );
    }

    this.accessToken = parsedKey.data.access_token;
  }

  private async githubRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com${url}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.log.error(`GitHub API error: ${response.status} ${errorBody}`);
      throw new Error(`GitHub API request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private buildIssueBody(event: CalendarEvent): string {
    const attendees = event.attendees.map((a) => `- ${a.name} (${a.email})`).join("\n");

    const lines = [
      `## Booking Details`,
      ``,
      `**Event:** ${event.title}`,
      `**Start:** ${new Date(event.startTime).toISOString()}`,
      `**End:** ${new Date(event.endTime).toISOString()}`,
      `**Organizer:** ${event.organizer.name} (${event.organizer.email})`,
      ``,
      `### Attendees`,
      attendees,
    ];

    if (event.additionalNotes) {
      lines.push(``, `### Additional Notes`, event.additionalNotes);
    }

    if (event.location) {
      lines.push(``, `**Location:** ${event.location}`);
    }

    return lines.join("\n");
  }

  private getDefaultRepo(): { owner: string; repo: string } | null {
    const repoEnv = process.env.GITHUB_DEFAULT_REPO;
    if (!repoEnv) return null;

    const parts = repoEnv.split("/");
    if (parts.length !== 2) return null;

    return { owner: parts[0], repo: parts[1] };
  }

  private async getAuthenticatedUser(): Promise<{ login: string }> {
    return this.githubRequest<{ login: string }>("/user");
  }

  private async findUserRepo(login: string): Promise<{ owner: string; repo: string } | null> {
    const repos = await this.githubRequest<{ full_name: string; name: string; owner: { login: string } }[]>(
      `/users/${login}/repos?sort=updated&per_page=1`
    );

    if (repos.length === 0) return null;

    return { owner: repos[0].owner.login, repo: repos[0].name };
  }

  private async getRepo(): Promise<{ owner: string; repo: string }> {
    const defaultRepo = this.getDefaultRepo();
    if (defaultRepo) return defaultRepo;

    const user = await this.getAuthenticatedUser();
    const userRepo = await this.findUserRepo(user.login);

    if (userRepo) return userRepo;

    throw new Error("No GitHub repository found. Set GITHUB_DEFAULT_REPO environment variable.");
  }

  async createEvent(event: CalendarEvent, contacts: Contact[]): Promise<CrmEvent> {
    const { owner, repo } = await this.getRepo();

    const issue = await this.githubRequest<{ id: number; number: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Booking: ${event.title}`,
          body: this.buildIssueBody(event),
          labels: ["cal.com", "booking"],
        }),
      }
    );

    this.log.debug("GitHub issue created", { issueNumber: issue.number, url: issue.html_url });

    return {
      uid: String(issue.number),
      id: String(issue.id),
      type: "github_crm",
      password: "",
      url: issue.html_url,
    };
  }

  async updateEvent(uid: string, event: CalendarEvent): Promise<CrmEvent> {
    const { owner, repo } = await this.getRepo();

    const issue = await this.githubRequest<{ id: number; number: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues/${uid}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          title: `Booking (Updated): ${event.title}`,
          body: this.buildIssueBody(event),
        }),
      }
    );

    return {
      id: String(issue.id),
    };
  }

  async deleteEvent(uid: string): Promise<void> {
    const { owner, repo } = await this.getRepo();

    await this.githubRequest(`/repos/${owner}/${repo}/issues/${uid}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "closed",
        state_reason: "not_planned",
      }),
    });
  }

  async getContacts({
    emails,
  }: {
    emails: string | string[];
    includeOwner?: boolean;
    forRoundRobinSkip?: boolean;
  }): Promise<Contact[]> {
    const emailArray = Array.isArray(emails) ? emails : [emails];
    const contacts: Contact[] = [];

    for (const email of emailArray) {
      try {
        const searchResult = await this.githubRequest<{
          total_count: number;
          items: { id: number; login: string; email: string | null }[];
        }>(`/search/users?q=${encodeURIComponent(email)}+in:email`);

        for (const user of searchResult.items) {
          contacts.push({
            id: String(user.id),
            email: user.email || email,
          });
        }
      } catch (e) {
        this.log.warn(`Could not search GitHub user for email ${email}`, e);
      }
    }

    return contacts;
  }

  async createContacts(
    contactsToCreate: ContactCreateInput[],
    organizerEmail?: string,
    calEventResponses?: CalEventResponses | null
  ): Promise<Contact[]> {
    return contactsToCreate.map((contact, index) => ({
      id: `github-contact-${index}`,
      email: contact.email,
    }));
  }

  getAppOptions() {
    return null;
  }

  async handleAttendeeNoShow(bookingUid: string, attendees: { email: string; noShow: boolean }[]) {
    try {
      const { owner, repo } = await this.getRepo();

      const noShowAttendees = attendees
        .filter((a) => a.noShow)
        .map((a) => a.email)
        .join(", ");

      if (noShowAttendees) {
        await this.githubRequest(`/repos/${owner}/${repo}/issues/${bookingUid}/comments`, {
          method: "POST",
          body: JSON.stringify({
            body: `**No-show reported** for: ${noShowAttendees}`,
          }),
        });
      }
    } catch (e) {
      this.log.error("Failed to handle attendee no-show on GitHub", e);
    }
  }
}
