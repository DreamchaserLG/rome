import type { ProveIdentityResult } from "./instance-identity.js";

/**
 * What an agent may learn about the guardian from Rome Cloud's whoami: enough
 * to tailor help to their work, and nothing that identifies or reaches them.
 * The email, sign-in links, social handles, location, cited facts and matched
 * accounts stay out, as do the report's staff notes (identity basis, survey
 * fit, limitations).
 */
export interface CloudProfile {
  /** The name their sign-in reports. */
  name: string | null;
  /** What they told the preview survey. */
  survey: {
    background: string | null;
    buildGoals: string[];
    buildDescription: string | null;
  } | null;
  /** Their public professional profile, only when Signup Research matched it
   *  to them (confirmed or likely). */
  publicProfile: {
    headline: string | null;
    role: string | null;
    company: string | null;
    summary: string | null;
  } | null;
}

export type CloudProfileOutcome =
  | { kind: "ok"; profile: CloudProfile }
  /** Not enrolled with Rome Cloud, unreachable, or the token was rejected. */
  | { kind: "unavailable"; reason: string };

export interface CloudProfileService {
  get(): Promise<CloudProfileOutcome>;
}

const MATCHED_IDENTITIES = new Set(["confirmed", "likely"]);

/** Read the whoami `account` field by field: older Rome Clouds send only
 *  id/email/avatarUrl, and any part may be null. */
export function readCloudProfile(account: unknown): CloudProfile {
  const a = record(account);
  const survey = record(a?.survey);
  const report = record(record(a?.research)?.report);
  const matched = MATCHED_IDENTITIES.has(text(record(report?.identity)?.status) ?? "");
  const background =
    text(survey?.professionalBackgroundOther) ?? text(survey?.professionalBackground);
  return {
    name: text(a?.displayName),
    survey: survey
      ? {
          background,
          buildGoals: Array.isArray(survey.buildGoals)
            ? survey.buildGoals.flatMap((goal) => text(goal) ?? [])
            : [],
          buildDescription: text(survey.buildDescription),
        }
      : null,
    publicProfile:
      report && matched
        ? {
            headline: text(report.headline),
            role: text(report.role),
            company: text(report.company),
            summary: text(report.summary),
          }
        : null,
  };
}

/** Main-process reader: the instance token never leaves main, so workers reach
 *  this through `CloudProfileProxy`. Unlike the heartbeat, a rejected token
 *  is only reported here; clearing it stays with the enrollment flow. */
export class CloudProfileClient implements CloudProfileService {
  constructor(private readonly prove: () => Promise<ProveIdentityResult>) {}

  async get(): Promise<CloudProfileOutcome> {
    const result = await this.prove();
    if (result.status !== "ok") return { kind: "unavailable", reason: result.status };
    return { kind: "ok", profile: result.identity.profile ?? readCloudProfile(null) };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
