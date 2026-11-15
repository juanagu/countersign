export const BOT_CLIENT = 'bot';
export const GATEWAY_CLIENT = 'mcp-gateway';
export const GATEWAY_AUDIENCE = 'mcp-gateway';

/** The most each resource server may be granted. A request can narrow it, never widen it. */
export const AUDIENCE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'mcp-accounts': ['accounts:read'],
  'mcp-payments': ['beneficiaries:read', 'transfers:prepare', 'transfers:execute'],
  // The gateway fronts both servers, so its ceiling is theirs together (ADR 017).
  [GATEWAY_AUDIENCE]: ['accounts:read', 'beneficiaries:read', 'transfers:prepare', 'transfers:execute'],
};

/** What one confidential client may do at the token endpoint (ADR 017). */
export interface ClientPolicy {
  /** The only audience of subject token this client may present. */
  subjectAudience: string;
  /** The actor chain the subject token must carry exactly, outermost first. */
  subjectActors: readonly string[];
  /** The only audiences this client may ask for. */
  targets: readonly string[];
  /** Whether issued scopes are capped by the subject token's own (true once the subject holds banking scopes). */
  inheritSubjectScopes: boolean;
}

export const CLIENT_POLICIES: Readonly<Record<string, ClientPolicy>> = {
  // The bot reaches the backends only through the gateway, so it may ask for no other audience (rule 1).
  [BOT_CLIENT]: {
    subjectAudience: 'bot',
    subjectActors: [],
    targets: [GATEWAY_AUDIENCE],
    inheritSubjectScopes: false,
  },
  [GATEWAY_CLIENT]: {
    subjectAudience: GATEWAY_AUDIENCE,
    subjectActors: [BOT_CLIENT],
    targets: ['mcp-accounts', 'mcp-payments'],
    inheritSubjectScopes: true,
  },
};
