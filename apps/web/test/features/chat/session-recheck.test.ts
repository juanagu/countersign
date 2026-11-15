import { CopilotKitCoreErrorCode } from '@copilotkit/react-core/v2';
import { describe, expect, it } from 'vitest';
import { shouldRecheckSession } from '../../../src/features/chat/lib/session-recheck';

describe('shouldRecheckSession', () => {
  it.each([
    CopilotKitCoreErrorCode.RUNTIME_INFO_FETCH_FAILED,
    CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
    CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
  ])('rechecks after a failed runtime request (%s), which is how a 401 surfaces', (code) => {
    expect(shouldRecheckSession(code)).toBe(true);
  });

  it.each([
    CopilotKitCoreErrorCode.TOOL_HANDLER_FAILED,
    CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT,
    CopilotKitCoreErrorCode.AGENT_THREAD_LOCKED,
  ])('leaves the session alone for errors the bot or a tool reported (%s)', (code) => {
    expect(shouldRecheckSession(code)).toBe(false);
  });
});
