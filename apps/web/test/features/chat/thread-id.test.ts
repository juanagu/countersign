import { describe, expect, it } from 'vitest';
import {
  forgetThread,
  startNewThread,
  threadIdFor,
  type ThreadIdStorage,
} from '../../../src/features/chat/lib/thread-id';

function memoryStorage(): ThreadIdStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe('threadIdFor', () => {
  it('keeps one thread per user across reloads', () => {
    const storage = memoryStorage();
    let n = 0;
    const mint = () => `t${++n}`;
    expect(threadIdFor('ana', storage, mint)).toBe('t1');
    expect(threadIdFor('ana', storage, mint)).toBe('t1');
    expect(threadIdFor('juan', storage, mint)).toBe('t2');
  });

  it('starts a fresh thread after sign-out', () => {
    const storage = memoryStorage();
    let n = 0;
    const mint = () => `t${++n}`;
    threadIdFor('ana', storage, mint);
    forgetThread('ana', storage);
    expect(threadIdFor('ana', storage, mint)).toBe('t2');
  });

  it('still gives an id when storage is blocked', () => {
    const blocked: ThreadIdStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(threadIdFor('ana', blocked, () => 'x')).toBe('x');
    expect(threadIdFor('ana', null, () => 'y')).toBe('y');
    expect(() => forgetThread('ana', blocked)).not.toThrow();
  });
});

describe('startNewThread', () => {
  it('replaces the saved thread and keeps the new one across reloads', () => {
    const storage = memoryStorage();
    let n = 0;
    const mint = () => `t${++n}`;
    expect(threadIdFor('ana', storage, mint)).toBe('t1');
    expect(startNewThread('ana', storage, mint)).toBe('t2');
    expect(threadIdFor('ana', storage, mint)).toBe('t2');
  });

  it("leaves other users' threads alone", () => {
    const storage = memoryStorage();
    let n = 0;
    const mint = () => `t${++n}`;
    threadIdFor('juan', storage, mint);
    startNewThread('ana', storage, mint);
    expect(threadIdFor('juan', storage, mint)).toBe('t1');
  });

  it('still returns a fresh id when storage is blocked', () => {
    let n = 0;
    expect(startNewThread('ana', null, () => `t${++n}`)).toBe('t1');
  });
});
