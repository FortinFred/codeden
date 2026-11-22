/**
 * A configured SSH host for a Forgejo connection (`docs/forges.md` §7): a host name or IPv4
 * address with an optional port, or a bracketed IPv6 literal with an optional port. A user,
 * scheme, path or whitespace never matches, because an SSH alias is not proof of a forge.
 */
export interface ForgejoSshHost {
  host: string;
  /** The configured port, or null for the SSH default. */
  port: number | null;
}

export function parseForgejoSshHost(value: string): ForgejoSshHost | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s/@]/.test(trimmed) || trimmed.includes("://")) return null;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (ipv6?.[1]) return { host: ipv6[1], port: portOf(ipv6[2]) };
  if (trimmed.startsWith("[")) return null;
  const named = /^([^:]+)(?::(\d+))?$/.exec(trimmed);
  if (!named?.[1]) return null;
  return { host: named[1], port: portOf(named[2]) };
}

function portOf(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}
