import type { CopilotChatView } from '@copilotkit/react-core/v2';
import { createContext, useContext, type ComponentProps } from 'react';
import { useChatActions } from '../genui/chat-actions';
import { Icon } from '../../shared/ui/icon';
import { WELCOME_TILES } from './welcome-tiles';
import './welcome-screen.css';

/** The signed-in user's first name, which the greeting reads (the slot component takes no props of ours). */
export const WelcomeNameContext = createContext('');

type WelcomeScreenProps = ComponentProps<typeof CopilotChatView.WelcomeScreen>;

/** Empty-conversation greeting and shortcuts; the composer stays docked below, where it will be all along. */
export function WelcomeScreen({ input }: WelcomeScreenProps) {
  const name = useContext(WelcomeNameContext);
  const { sendMessage } = useChatActions();
  return (
    <div className="welcome">
      <div className="welcome__scroll">
        <div className="welcome__column">
          <h1 className="welcome__title">{name ? `Hola, ${name}` : 'Hola'}</h1>
          <p className="welcome__sub">¿Qué querés resolver hoy?</p>
          <ul className="welcome__tiles">
            {WELCOME_TILES.map((tile) => (
              <li key={tile.label}>
                <button type="button" className="welcome__tile" onClick={() => sendMessage(tile.message)}>
                  <Icon name={tile.icon} size={22} />
                  <span>{tile.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="welcome__dock">{input}</div>
    </div>
  );
}
