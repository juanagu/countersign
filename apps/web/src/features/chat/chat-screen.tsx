import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import type { SessionUser } from '../auth/lib/auth-api';
import { Button } from '../../shared/ui/button';
import { CHAT_LABELS } from './chat-labels';
import './chat-screen.css';

const RUNTIME_URL = '/api/copilotkit';

export interface ChatScreenProps {
  user: SessionUser;
  onSignOut: () => void;
}

export function ChatScreen({ user, onSignOut }: ChatScreenProps) {
  return (
    <div className="chat-layout">
      <header className="chat-header">
        <span className="chat-header__brand">Asistente bancario</span>
        <span className="chat-header__user muted">{user.name}</span>
        <Button variant="ghost" onClick={onSignOut}>
          Salir
        </Button>
      </header>
      <main className="chat-main">
        <CopilotKitProvider runtimeUrl={RUNTIME_URL} showDevConsole={false} enableInspector={false}>
          <CopilotChat labels={CHAT_LABELS} />
        </CopilotKitProvider>
      </main>
    </div>
  );
}
