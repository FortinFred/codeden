import { z } from "zod";

/**
 * Timestamps as an issue file holds them (`docs/issue-sources.md` §5.8): RFC 3339, UTC, `Z`
 * suffix, second precision. Hand edits may use fractional seconds or a numeric offset; the
 * parser normalizes those, and the renderer only ever writes the canonical form.
 */
export const IssueFileTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    "must be an RFC 3339 UTC timestamp with second precision, e.g. 2026-11-23T09:14:00Z",
  );
export type IssueFileTimestamp = z.infer<typeof IssueFileTimestamp>;

const ISSUE_TIMESTAMP_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Normalize an RFC 3339 timestamp to the file format's UTC second precision, or null when it is
 * not a real timestamp. Fractional seconds are dropped and numeric offsets converted, which is
 * what §5.8 asks of a hand edit; a date a YAML parser read without quotes is just a string here.
 */
export function normalizeIssueTimestamp(value: string): string | null {
  const match = ISSUE_TIMESTAMP_INPUT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone = "Z"] = match;
  const year = Number(y ?? 0);
  const month = Number(mo ?? 0);
  const day = Number(d ?? 0);
  const hour = Number(h ?? 0);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const whole = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(whole.getTime())) return null;
  if (
    whole.getUTCFullYear() !== year ||
    whole.getUTCMonth() !== month - 1 ||
    whole.getUTCDate() !== day
  ) {
    return null;
  }
  const millis = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  let offsetMs = 0;
  if (zone !== "Z" && zone !== "z") {
    const [offsetHours = 0, offsetMinutes = 0] = zone.slice(1).split(":").map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetMs = (zone.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  const iso = new Date(whole.getTime() + millis - offsetMs).toISOString();
  return `${iso.slice(0, 19)}Z`;
}
