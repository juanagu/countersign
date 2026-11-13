import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useState } from 'react';
import type { SessionUser } from '../auth/lib/auth-api';
import { Button } from '../../shared/ui/button';
import { CHAT_LABELS } from './chat-labels';
import { shouldRecheckSession } from './lib/session-recheck';
import './chat-screen.css';

const RUNTIME_URL = '/api/copilotkit';

export interface ChatScreenProps {
  user: SessionUser;
  /** Rejects when the BFF did not end the session; the screen then stays and says so. */
  onSignOut: () => Promise<void>;
  /** A runtime call failed; the app checks whether the session expired. */
  onRuntimeRequestFailed: () => void;
}

export function ChatScreen({ user, onSignOut, onRuntimeRequestFailed }: ChatScreenProps) {
  const [signOutFailed, setSignOutFailed] = useState(false);

  function signOut() {
    setSignOutFailed(false);
    onSignOut().catch(() => setSignOutFailed(true));
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
      <main className="chat-main">
        <CopilotKitProvider
          runtimeUrl={RUNTIME_URL}
          showDevConsole={false}
          enableInspector={false}
          onError={({ code }) => {
            if (shouldRecheckSession(code)) onRuntimeRequestFailed();
          }}
        >
          <CopilotChat labels={CHAT_LABELS} />
        </CopilotKitProvider>
      </main>
    </div>
  );
}
