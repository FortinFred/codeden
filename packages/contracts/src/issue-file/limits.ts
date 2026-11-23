/**
 * Limits of one issue file (`docs/issue-sources.md` §5.3–§5.7). They are shared by the schema,
 * the parser and the renderer so a file that parses is one the writer would produce.
 */

/** Most labels one issue may carry (§5.3). */
export const MAX_ISSUE_LABELS = 20;
/** Longest label name (§5.3). */
export const MAX_ISSUE_LABEL_LENGTH = 100;
/** Longest issue title (§5.3). */
export const MAX_ISSUE_TITLE_LENGTH = 256;
/** Most comments one issue file may hold (§5.4). */
export const MAX_ISSUE_COMMENTS = 200;
/** Longest body an issue file may hold; the projection truncates at 20,000 (§5.4). */
export const MAX_ISSUE_BODY_LENGTH = 65_000;
/** Largest issue file (§5.7). */
export const MAX_ISSUE_FILE_BYTES = 1024 * 1024;
/** Largest front matter section of an issue file (§5.7). */
export const MAX_ISSUE_FRONT_MATTER_BYTES = 64 * 1024;
/** Longest filename slug, in characters (§5.1). */
export const MAX_ISSUE_SLUG_LENGTH = 60;
