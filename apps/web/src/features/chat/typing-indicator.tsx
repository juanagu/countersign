import type { HTMLAttributes } from 'react';

/** The "assistant is writing" dots, in place of CopilotKit's pulsing cursor. */
export function TypingIndicator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-testid="copilot-loading-cursor"
      role="status"
      aria-label="Escribiendo"
      className={className ? `typing ${className}` : 'typing'}
      {...props}
    >
      <span />
      <span />
      <span />
    </div>
  );
}
