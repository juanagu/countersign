import { CopilotChatView, type CopilotChatViewProps } from '@copilotkit/react-core/v2';
import { ChatInput } from './connection-pill';
import { WelcomeScreen } from './welcome-screen';

/**
 * CopilotChat hides its welcome screen whenever it is given a `threadId`, and ours always is (one resumable
 * thread per user). The welcome still waits for the connect to finish, so a restored thread never flashes it.
 */
export function ChatView(props: CopilotChatViewProps) {
  return <CopilotChatView {...props} hasExplicitThreadId={false} welcomeScreen={WelcomeScreen} input={ChatInput} />;
}
