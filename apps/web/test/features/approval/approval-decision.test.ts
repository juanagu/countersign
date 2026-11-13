import type { TransferConfirmData } from '@poc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { cancelTransfer, confirmTransfer, type InFlight } from '../../../src/features/approval/lib/approval-decision';
import { StepUpFailed } from '../../../src/features/approval/lib/step-up-api';

const DRAFT = { draftId: 'drf_1' } as TransferConfirmData;

const idle = (): InFlight => ({ current: false });

describe('confirmTransfer', () => {
  it('resumes with the step-up token for the draft', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const result = await confirmTransfer(idle(), DRAFT, '123456', { stepUp: async () => 'tok', onDecide });
    expect(result).toEqual({ kind: 'done' });
    expect(onDecide).toHaveBeenCalledWith({ approved: true, editedArgs: { draft_id: 'drf_1', step_up_token: 'tok' } });
  });

  it('decides once when clicked twice', async () => {
    const guard = idle();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const stepUp = vi.fn().mockResolvedValue('tok');
    const [first, second] = await Promise.all([
      confirmTransfer(guard, DRAFT, '123456', { stepUp, onDecide }),
      confirmTransfer(guard, DRAFT, '123456', { stepUp, onDecide }),
    ]);
    expect([first.kind, second.kind]).toEqual(['done', 'busy']);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect((await cancelTransfer(guard, onDecide)).kind).toBe('busy');
  });

  it('frees the guard and asks for a new PIN after a failed resume', async () => {
    const guard = idle();
    const stepUp = vi.fn().mockResolvedValueOnce('spent').mockResolvedValueOnce('fresh');
    const onDecide = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const failed = await confirmTransfer(guard, DRAFT, '123456', { stepUp, onDecide });
    expect(failed).toEqual({ kind: 'failed', error: 'resume_failed' });
    expect(guard.current).toBe(false);
    expect(await confirmTransfer(guard, DRAFT, '123456', { stepUp, onDecide })).toEqual({ kind: 'done' });
    expect(onDecide).toHaveBeenLastCalledWith(
      expect.objectContaining({ editedArgs: expect.objectContaining({ step_up_token: 'fresh' }) }),
    );
  });

  it('reports a step-up failure and lets the customer retry', async () => {
    const guard = idle();
    const onDecide = vi.fn();
    const stepUp = vi.fn().mockRejectedValue(new StepUpFailed('invalid_pin'));
    expect(await confirmTransfer(guard, DRAFT, '000000', { stepUp, onDecide })).toEqual({
      kind: 'failed',
      error: 'invalid_pin',
    });
    expect(guard.current).toBe(false);
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('cancelTransfer', () => {
  it('works again after a failed resume, and only once after success', async () => {
    const guard = idle();
    const onDecide = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    expect(await cancelTransfer(guard, onDecide)).toEqual({ kind: 'failed', error: 'resume_failed' });
    expect(await cancelTransfer(guard, onDecide)).toEqual({ kind: 'done' });
    expect(await cancelTransfer(guard, onDecide)).toEqual({ kind: 'busy' });
    expect(onDecide).toHaveBeenCalledTimes(2);
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ approved: false }));
  });
});
