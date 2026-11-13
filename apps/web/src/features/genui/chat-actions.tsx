import { useAgent, useCopilotKit } from '@copilotkit/react-core/v2';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

interface ChatActions {
  /** Sends `text` as the user's next message, as if typed. */
  sendMessage: (text: string) => void;
}

const ChatActionsContext = createContext<ChatActions | null>(null);

export function ChatActionsProvider({ children }: { children: ReactNode }) {
  const { agent } = useAgent();
  const { copilotkit } = useCopilotKit();
  const sendMessage = useCallback(
    (text: string) => {
      if (agent.isRunning) return;
      agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
      void copilotkit.runAgent({ agent });
    },
    [agent, copilotkit],
  );
  const value = useMemo(() => ({ sendMessage }), [sendMessage]);
  return <ChatActionsContext.Provider value={value}>{children}</ChatActionsContext.Provider>;
}

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) throw new Error('useChatActions must be used inside ChatActionsProvider');
  return actions;
}
