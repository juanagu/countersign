import type { Message, RunAgentInput } from '@ag-ui/client';
import { describe, expect, it } from 'vitest';
import { loggableRunInput } from '../../../../src/features/chat/runner/logged-run-input.js';

const token = 'eyJhbGciOiJFUzI1NiJ9.step-up.signature';
const user: Message = { id: 'u1', role: 'user', content: 'transferí 100 a Juan' };
const toolMessage = (id: string, content: string): Message => ({ id, role: 'tool', toolCallId: `call-${id}`, content });

const runInput = (messages: Message[], extra: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: 't1',
  runId: 'r1',
  messages,
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...extra,
});

describe('loggableRunInput', () => {
  it('drops a tool message carrying the step-up token even when the run resumes nothing', () => {
    const leaked = toolMessage('a', JSON.stringify({ approved: true, editedArgs: { step_up_token: token } }));
    const logged = loggableRunInput(runInput([user, leaked]));
    expect(logged.messages).toEqual([user]);
  });

  it("drops the answer to a cancelled interrupt and keeps other tools' results", () => {
    const cancelled = toolMessage('a', JSON.stringify({ status: 'cancelled' }));
    const balance = toolMessage('b', JSON.stringify({ balance: 100 }));
    const resume = [{ interruptId: 'int-call-a', status: 'cancelled' as const }];
    const logged = loggableRunInput(runInput([user, cancelled, balance], { resume }));
    expect(logged.messages).toEqual([user, balance]);
    expect(logged.resume).toEqual(resume);
  });

  it('scrubs a credential key wherever else the input carries it', () => {
    const forwardedProps = { command: { resume: { editedArgs: { step_up_token: token } } }, keep: 1 };
    const logged = loggableRunInput(runInput([user], { forwardedProps, state: { step_up_token: token } }));
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(logged.forwardedProps).toEqual({ command: { resume: {} }, keep: 1 });
  });
});
