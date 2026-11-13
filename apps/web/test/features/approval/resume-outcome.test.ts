import { describe, expect, it } from 'vitest';
import { showsResumeFailed } from '../../../src/features/approval/lib/resume-outcome';

const approve = { resume: [{ status: 'resolved', payload: { approved: true, editedArgs: {} } }] };
const deny = { resume: [{ status: 'resolved', payload: { approved: false } }] };
const cancel = { resume: [{ status: 'cancelled' }] };
const newTurn = {};

describe('showsResumeFailed', () => {
  it('shows the notice when the run resuming an approval fails', () => {
    expect(showsResumeFailed(false, 'failed', approve)).toBe(true);
  });

  it('says nothing when a cancel or an ordinary turn fails', () => {
    expect(showsResumeFailed(false, 'failed', deny)).toBe(false);
    expect(showsResumeFailed(false, 'failed', cancel)).toBe(false);
    expect(showsResumeFailed(false, 'failed', newTurn)).toBe(false);
    expect(showsResumeFailed(false, 'failed', undefined)).toBe(false);
  });

  it('keeps the notice through a later failure and clears it when any run starts', () => {
    expect(showsResumeFailed(true, 'failed', newTurn)).toBe(true);
    expect(showsResumeFailed(true, 'started', newTurn)).toBe(false);
    expect(showsResumeFailed(true, 'started', approve)).toBe(false);
  });

  it('follows the lifecycle of a failed resume and the customer asking again', () => {
    let shown = showsResumeFailed(false, 'started', approve); // useInterrupt unmounts the panel here.
    shown = showsResumeFailed(shown, 'failed', approve);
    expect(shown).toBe(true);
    expect(showsResumeFailed(shown, 'started', newTurn)).toBe(false);
  });
});
