import { z } from "zod";

/**
 * The number reservation ledger (`docs/issue-sources.md` §5.5): a committed `<folder>/.numbers`
 * document that is the cross-server allocator, not a cache. Numbers are never reused.
 */

/** The reservation ledger's filename inside the issue folder (§5.5); not an issue file. */
export const ISSUE_NUMBER_LEDGER_FILE = ".numbers";

/**
 * `<folder>/.numbers` (§5.5): `next` is the next number to hand out. The ledger is committed
 * repository data and the cross-server allocator, not a cache: a reservation moves it with a
 * compare-and-swap write, so two clones cannot receive the same number. It holds no other state.
 */
export const IssueNumberLedger = z.object({ next: z.int().positive() }).strict();
export type IssueNumberLedger = z.infer<typeof IssueNumberLedger>;

/** What reading a ledger file gave: a ledger, no ledger yet, or a malformed one (§5.5). */
export type IssueNumberLedgerRead =
  | { ok: true; ledger: IssueNumberLedger | null }
  | { ok: false; detail: string };

/**
 * Read the `.numbers` file. A missing ledger is not an error — the next number is derived from
 * the files (§5.5) — but a malformed one is returned as such, so reads still work and creates are
 * refused until a person fixes it.
 */
export function parseIssueNumberLedger(text: string | null): IssueNumberLedgerRead {
  if (text === null) return { ok: true, ledger: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: "The number ledger is not valid JSON" };
  }
  const parsed = IssueNumberLedger.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      detail: 'The number ledger must be exactly { "next": <positive integer> }',
    };
  }
  return { ok: true, ledger: parsed.data };
}

/** The canonical `.numbers` content: fixed two-space JSON with a trailing newline. */
export function renderIssueNumberLedger(ledger: IssueNumberLedger): string {
  return `${JSON.stringify({ next: ledger.next }, null, 2)}\n`;
}

/**
 * The next number to allocate (§5.5): `max(ledger.next, max file number + 1)`, at least 1. A
 * ledger below an existing file is corrected upward here, never downward; a gap left by a
 * reservation that never wrote its file stays, so numbers are never reused.
 */
export function nextIssueNumber(input: {
  ledgerNext?: number | null;
  numbers?: readonly number[];
}): number {
  const ledgerNext = input.ledgerNext ?? 1;
  const highest = input.numbers?.reduce((max, number) => Math.max(max, number), 0) ?? 0;
  return Math.max(ledgerNext, highest + 1, 1);
}
