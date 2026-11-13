import { CopilotKitCoreErrorCode } from '@copilotkit/react-core/v2';

// The runtime reports a 401 (expired session) as a failed request, without the status, so any failed
// call to the runtime is a reason to ask the BFF whether the session is still there.
const RUNTIME_REQUEST_FAILURES: ReadonlySet<CopilotKitCoreErrorCode> = new Set([
  CopilotKitCoreErrorCode.RUNTIME_INFO_FETCH_FAILED,
  CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
  CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
]);

export function shouldRecheckSession(code: CopilotKitCoreErrorCode): boolean {
  return RUNTIME_REQUEST_FAILURES.has(code);
}
