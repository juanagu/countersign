/** Deepest delegation chain a verifier will read; anything longer is not a chain this system issues. */
const MAX_CHAIN_DEPTH = 4;
const CHAIN_SEPARATOR = '>';

/** Reads the nested RFC 8693 `act` claim into an array, outermost first. Undefined when malformed. */
export function readActorChain(act: unknown): string[] | undefined {
  const chain: string[] = [];
  let current: unknown = act;
  while (current !== undefined) {
    if (chain.length >= MAX_CHAIN_DEPTH || typeof current !== 'object' || current === null) return undefined;
    const { sub, act: inner } = current as { sub?: unknown; act?: unknown };
    if (typeof sub !== 'string' || sub === '') return undefined;
    chain.push(sub);
    current = inner;
  }
  return chain.length > 0 ? chain : undefined;
}

export function chainsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((actor, index) => actor === b[index]);
}

/**
 * Parses `bot` or `mcp-gateway>bot` (outermost first), comma-separated for several chains. A server's
 * accepted chains come from config this way, so cutting over to the gateway needs no code change.
 */
export function parseActorChains(spec: string): string[][] {
  return spec
    .split(',')
    .map((chain) =>
      chain
        .split(CHAIN_SEPARATOR)
        .map((actor) => actor.trim())
        .filter(Boolean),
    )
    .filter((chain) => chain.length > 0);
}
