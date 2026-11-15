import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { TransferApproval } from '../approval/transfer-approval';
import { bankTemplateRenderer } from '../genui/bank-templates';
import { bankCatalog } from '../genui/catalog';
import { ChatActionsProvider } from '../genui/chat-actions';
import '@copilotkit/react-core/v2/styles.css';
import { useState } from 'react';
import type { SessionUser } from '../auth/lib/auth-api';
import { ASSISTANT_MARKDOWN } from './assistant-markdown';
import { ChatHeader } from './chat-header';
import { CHAT_LABELS } from './chat-labels';
import { ChatView } from './chat-view';
import { shouldRecheckSession } from './lib/session-recheck';
import { forgetThread, startNewThread, threadIdFor } from './lib/thread-id';
import { firstName } from './lib/user-name';
import { RunErrorNotice } from './run-error-notice';
import { StreamReconnect } from './stream-reconnect';
import { ToolStatus } from './tool-status';
import { TypingIndicator } from './typing-indicator';
import { WelcomeNameContext } from './welcome-screen';
import './chat-screen.css';
import './chat-messages.css';
import './chat-composer.css';

const RUNTIME_URL = '/api/copilotkit';
// Stable references: the provider re-registers renderers when these change identity.
const A2UI = { catalog: bankCatalog };
const ACTIVITY_RENDERERS = [bankTemplateRenderer];
const MESSAGE_VIEW = { cursor: TypingIndicator, assistantMessage: { markdownRenderer: ASSISTANT_MARKDOWN } };
const CONNECTING_INDICATOR = 'chat-connecting';

export interface ChatScreenProps {
  user: SessionUser;
  /** Rejects when the BFF did not end the session; the screen then stays and says so. */
  onSignOut: () => Promise<void>;
  /** A runtime call failed; the app checks whether the session expired. */
  onRuntimeRequestFailed: () => void;
}

export function ChatScreen({ user, onSignOut, onRuntimeRequestFailed }: ChatScreenProps) {
  const [signOutFailed, setSignOutFailed] = useState(false);
  // One thread per signed-in user, restored on reload; sign-out and "Nueva conversación" start a new one.
  const [threadId, setThreadId] = useState(() => threadIdFor(user.id));
  const [resumeFailed, setResumeFailed] = useState(false);

  function signOut() {
    setSignOutFailed(false);
    onSignOut()
      .then(() => forgetThread(user.id))
      .catch(() => setSignOutFailed(true));
  }

  function newConversation() {
    setResumeFailed(false);
    setThreadId(startNewThread(user.id));
  }

  return (
    <div className="chat-layout">
      <ChatHeader user={user} onNewConversation={newConversation} onSignOut={signOut} />
      {signOutFailed && (
        <p role="alert" className="chat-alert">
          No pudimos cerrar la sesión. Probá de nuevo.
        </p>
      )}
      <main className="chat-main">
        <CopilotKitProvider
          runtimeUrl={RUNTIME_URL}
          showDevConsole={false}
          enableInspector={false}
          a2ui={A2UI}
          renderActivityMessages={ACTIVITY_RENDERERS}
          onError={({ code }) => {
            if (shouldRecheckSession(code)) onRuntimeRequestFailed();
          }}
        >
          <StreamReconnect />
          <ToolStatus />
          <RunErrorNotice />
          <TransferApproval resumeFailed={resumeFailed} setResumeFailed={setResumeFailed}>
            <ChatActionsProvider>
              <WelcomeNameContext.Provider value={firstName(user.name)}>
                <CopilotChat
                  labels={CHAT_LABELS}
                  threadId={threadId}
                  chatView={ChatView}
                  messageView={MESSAGE_VIEW}
                  connectingIndicator={CONNECTING_INDICATOR}
                />
              </WelcomeNameContext.Provider>
            </ChatActionsProvider>
          </TransferApproval>
        </CopilotKitProvider>
      </main>
    </div>
  );
}
