/** The caller of an MCP tool, taken from a verified, audience-bound access token. */
export interface Principal {
  /** Customer id; every resource lookup is scoped to it. */
  sub: string;
  scopes: ReadonlySet<string>;
  /** The agent acting for the customer (RFC 8693 `act.sub`). */
  actor: string;
}
