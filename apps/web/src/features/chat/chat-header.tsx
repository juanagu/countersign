import type { SessionUser } from '../auth/lib/auth-api';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { initials } from './lib/user-name';
import './chat-header.css';

export interface ChatHeaderProps {
  user: SessionUser;
  onNewConversation: () => void;
  onSignOut: () => void;
}

function BrandMark() {
  return (
    <svg className="chat-header__mark" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--color-primary)" />
      <path
        d="M8 19.5V8.5h6.2a3 3 0 0 1 0 6H8m6.2 0a2.6 2.6 0 0 1 0 5H8"
        fill="none"
        stroke="var(--color-on-primary)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChatHeader({ user, onNewConversation, onSignOut }: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <div className="chat-header__brand">
        <BrandMark />
        <span className="chat-header__name">Banco Demo</span>
        <span className="chat-header__sub">Asistente</span>
      </div>
      <div className="chat-header__actions">
        <Button
          variant="ghost"
          className="chat-header__new"
          aria-label="Nueva conversación"
          onClick={onNewConversation}
        >
          <Icon name="edit" />
          <span className="chat-header__new-label" aria-hidden="true">
            Nueva conversación
          </span>
        </Button>
        <span className="chat-header__user">
          <span className="chat-header__avatar" role="img" aria-label={user.name}>
            {initials(user.name)}
          </span>
          <span className="chat-header__user-name">{user.name}</span>
        </span>
        <Button variant="ghost" className="chat-header__small" onClick={onSignOut}>
          Salir
        </Button>
      </div>
    </header>
  );
}
