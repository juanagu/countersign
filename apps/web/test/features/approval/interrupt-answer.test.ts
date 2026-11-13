import { describe, expect, it } from 'vitest';
import { withoutStepUpAnswers } from '../../../src/features/approval/lib/interrupt-answer';

// The tool message CopilotKit 1.87's `useInterrupt` `resolve(payload)` adds: its content is the payload.
const answer = {
  id: 'a',
  role: 'tool',
  toolCallId: 'call_1',
  content: JSON.stringify({ approved: true, editedArgs: { draft_id: 'drf_1', step_up_token: 'tok' } }),
};

describe('withoutStepUpAnswers', () => {
  it('drops the approval answer that carries the step-up token', () => {
    const user = { id: 'u', role: 'user', content: 'Mandale 50.000 a Ana' };
    expect(withoutStepUpAnswers([user, answer])).toEqual([user]);
  });

  it('keeps real tool results and a cancel answer, which carry no token', () => {
    const receipt = { id: 'r', role: 'tool', toolCallId: 'call_1', content: '{"reference":"BD-1"}' };
    const cancel = { id: 'c', role: 'tool', toolCallId: 'call_2', content: '{"status":"cancelled"}' };
    const text = { id: 't', role: 'tool', toolCallId: 'call_3', content: 'not json' };
    expect(withoutStepUpAnswers([receipt, cancel, text])).toEqual([receipt, cancel, text]);
  });

  it('keeps a user message that merely quotes the payload', () => {
    const user = { id: 'u', role: 'user', content: answer.content };
    expect(withoutStepUpAnswers([user])).toEqual([user]);
  });
});
