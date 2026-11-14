/** One MCP server behind the gateway. */
export interface Backend {
  /** Short name used in audit lines and error bodies, e.g. `payments`. */
  name: string;
  /** The `aud` the IdP issues for this server's tokens. */
  audience: string;
  url: string;
}

export function defaultBackends(urls: { accountsUrl: string; paymentsUrl: string }): Backend[] {
  return [
    { name: 'accounts', audience: 'mcp-accounts', url: urls.accountsUrl },
    { name: 'payments', audience: 'mcp-payments', url: urls.paymentsUrl },
  ];
}
