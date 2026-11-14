import { describe, expect, it } from 'vitest';
import { parseActorChains, readActorChain } from '../src/actor-chain.js';

describe('readActorChain', () => {
  it('flattens nested act claims', () => {
    expect(readActorChain({ sub: 'a', act: { sub: 'b', act: { sub: 'c' } } })).toEqual(['a', 'b', 'c']);
  });

  it.each([undefined, null, 'bot', { sub: 1 }, { act: { sub: 'x' } }, { sub: 'a', act: [] }])('rejects %j', (act) => {
    expect(readActorChain(act)).toBeUndefined();
  });

  it('rejects a chain deeper than any this system issues', () => {
    const deep = { sub: 'a', act: { sub: 'b', act: { sub: 'c', act: { sub: 'd', act: { sub: 'e' } } } } };
    expect(readActorChain(deep)).toBeUndefined();
  });
});

describe('parseActorChains', () => {
  it('parses one chain, outermost first', () => {
    expect(parseActorChains('mcp-gateway>bot')).toEqual([['mcp-gateway', 'bot']]);
  });

  it('parses several, ignoring blanks', () => {
    expect(parseActorChains('bot, mcp-gateway > bot,,')).toEqual([['bot'], ['mcp-gateway', 'bot']]);
  });

  it('yields nothing for an empty spec', () => {
    expect(parseActorChains('')).toEqual([]);
  });
});
