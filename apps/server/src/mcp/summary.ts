/**
 * One line about a tool, for a list an agent reads (the skill channel's SKILL.md): the tool's
 * own description, collapsed to one line and cut at a word boundary when it is long.
 */
export function toolSummary(description: string, max = 160): string {
  const line = description.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}...`;
}
