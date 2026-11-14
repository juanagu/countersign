import { useAgent, useCopilotKit } from '@copilotkit/react-core/v2';
import { useEffect, useState } from 'react';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';

interface RunInputLike {
  resume?: readonly unknown[];
}

/** A failed resume of an approval is reported on the confirm card; retrying it here would run it without the answer. */
const isResume = (input: RunInputLike | undefined) => (input?.resume?.length ?? 0) > 0;

function Notice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="run-notice" role="alert">
      <Icon name="alert" size={18} />
      <p>No pudimos responder tu consulta.</p>
      <Button variant="secondary" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

/**
 * Shows an inline notice at the end of the thread when a run fails, until the next run starts. Renders nothing
 * itself: the notice goes into CopilotKit's slot at the end of the message list.
 */
export function RunErrorNotice() {
  const { agent } = useAgent({ updates: [] });
  const { copilotkit } = useCopilotKit();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunStartedEvent: () => setFailed(false),
      onRunErrorEvent: ({ input }) => setFailed(!isResume(input)),
      onRunFailed: ({ input }) => setFailed(!isResume(input)),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    if (!failed) return;
    copilotkit.setInterruptElement(<Notice onRetry={() => void copilotkit.runAgent({ agent })} />);
    return () => copilotkit.setInterruptElement(null);
  }, [failed, agent, copilotkit]);

  return null;
}
