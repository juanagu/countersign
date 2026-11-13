import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { RESUME_FAILED_NOTICE } from '../approval/lib/resume-outcome';
import { TransferApproval } from '../approval/transfer-approval';
import { bankTemplateRenderer } from '../genui/bank-templates';
import { bankCatalog } from '../genui/catalog';
import { ChatActionsProvider } from '../genui/chat-actions';
import '@copilotkit/react-core/v2/styles.css';
import { useState } from 'react';
import type { SessionUser } from '../auth/lib/auth-api';
import { Button } from '../../shared/ui/button';
import { CHAT_LABELS } from './chat-labels';
import { shouldRecheckSession } from './lib/session-recheck';
import { forgetThread, threadIdFor } from './lib/thread-id';
import { StreamReconnect } from './stream-reconnect';
import './chat-screen.css';

const RUNTIME_URL = '/api/copilotkit';
// Stable references: the provider re-registers renderers when these change identity.
const A2UI = { catalog: bankCatalog };
const ACTIVITY_RENDERERS = [bankTemplateRenderer];

export interface ChatScreenProps {
  user: SessionUser;
  /** Rejects when the BFF did not end the session; the screen then stays and says so. */
  onSignOut: () => Promise<void>;
  /** A runtime call failed; the app checks whether the session expired. */
  onRuntimeRequestFailed: () => void;
}

export function ChatScreen({ user, onSignOut, onRuntimeRequestFailed }: ChatScreenProps) {
  const [signOutFailed, setSignOutFailed] = useState(false);
  // One thread per signed-in user, restored on reload; sign-out starts a new one.
  const [threadId] = useState(() => threadIdFor(user.id));
  const [resumeFailed, setResumeFailed] = useState(false);

  function signOut() {
    setSignOutFailed(false);
    onSignOut()
      .then(() => forgetThread(user.id))
      .catch(() => setSignOutFailed(true));
  }

  return (
    <div className="chat-layout">
      <header className="chat-header">
        <span className="chat-header__brand">Asistente bancario</span>
        <span className="chat-header__user muted">{user.name}</span>
        <Button variant="ghost" onClick={signOut}>
          Salir
        </Button>
      </header>
      {signOutFailed && (
        <p role="alert" className="chat-alert">
          No pudimos cerrar la sesión. Probá de nuevo.
        </p>
      )}
      {resumeFailed && (
        <p role="alert" className="chat-alert">
          {RESUME_FAILED_NOTICE}
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
          <TransferApproval setResumeFailed={setResumeFailed} />
          <ChatActionsProvider>
            <CopilotChat labels={CHAT_LABELS} threadId={threadId} />
          </ChatActionsProvider>
        </CopilotKitProvider>
      </main>
    </div>
  );
}
