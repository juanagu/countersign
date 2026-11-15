import { useRenderTool } from '@copilotkit/react-core/v2';
import { Icon } from '../../shared/ui/icon';
import { toolStatusLabel } from './lib/tool-labels';

interface ToolRenderProps {
  name: string;
  status: 'inProgress' | 'executing' | 'complete';
}

function renderToolStatus({ name, status }: ToolRenderProps) {
  const label = toolStatusLabel(name);
  if (status === 'complete' || !label) return null;
  return (
    <p className="tool-line" role="status">
      <Icon name="spinner" size={16} spin />
      {label}
    </p>
  );
}

/** Registers the status line for tools the bot runs; renders nothing itself. */
export function ToolStatus() {
  useRenderTool({ name: '*', render: renderToolStatus }, []);
  return null;
}
