/** The caller of an MCP tool, taken from a verified, audience-bound access token. */
export interface Principal {
  /** Customer id; every resource lookup is scoped to it. */
  sub: string;
  scopes: ReadonlySet<string>;
  /** The party that presented the token (RFC 8693 `act.sub`, the outermost actor). */
  actor: string;
  /** The whole delegation chain, outermost first, e.g. `['mcp-gateway', 'bot']`. */
  actors: readonly string[];
  /** The token's own id, so a caller can key a cache on it. */
  jti: string;
  /** Token expiry, seconds since epoch. */
  expiresAt: number;
}
