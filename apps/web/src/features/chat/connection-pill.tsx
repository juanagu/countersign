import { CopilotChatInput, type CopilotChatInputProps } from '@copilotkit/react-core/v2';
import { Icon } from '../../shared/ui/icon';
import { useConnectionStatus } from './lib/connection-status';

/** Says why the chat is quiet while the reconnector works; nothing when the connection is fine. */
function ConnectionPill() {
  const status = useConnectionStatus();
  if (status === 'idle') return null;
  const offline = status === 'waiting-online';
  return (
    <p className="conn" role="status">
      <Icon name={offline ? 'wifiOff' : 'spinner'} size={16} spin={!offline} />
      {offline ? 'Sin conexión. Reintentamos al reconectar.' : 'Reconectando…'}
    </p>
  );
}

/** CopilotKit's composer, with the connection pill centred above it (the `input` slot of the chat view). */
export function ChatInput(props: CopilotChatInputProps) {
  return (
    <>
      <ConnectionPill />
      <CopilotChatInput {...props} />
    </>
  );
}
