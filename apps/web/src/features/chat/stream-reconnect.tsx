import { useCopilotKit } from '@copilotkit/react-core/v2';
import { useEffect } from 'react';
import { createReconnector, isStreamBreak } from './lib/reconnector';

const AGENT_ID = 'default';

/** Inside the provider: when a run's stream breaks, re-attach to the same thread (ADR 015). Renders nothing. */
export function StreamReconnect() {
  const { copilotkit } = useCopilotKit();

  useEffect(() => {
    const reconnector = createReconnector({
      connect: async () => {
        const agent = copilotkit.getAgent(AGENT_ID);
        if (agent) await copilotkit.connectAgent({ agent });
      },
      isOnline: () => navigator.onLine,
      whenOnline: (callback) => {
        window.addEventListener('online', callback, { once: true });
        return () => window.removeEventListener('online', callback);
      },
      after: (ms, callback) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
    const subscription = copilotkit.subscribe({
      onError: ({ code }) => {
        if (isStreamBreak(code)) reconnector.streamBroke();
      },
    });
    return () => {
      subscription.unsubscribe();
      reconnector.dispose();
    };
  }, [copilotkit]);

  return null;
}
