import type { CopilotChatLabels } from '@copilotkit/react-core/v2';

export const CHAT_LABELS: Partial<CopilotChatLabels> = {
  chatInputPlaceholder: 'Escribí tu consulta…',
  chatInputToolbarSendButtonLabel: 'Enviar',
  chatInputToolbarStopButtonLabel: 'Detener',
  assistantMessageToolbarCopyMessageLabel: 'Copiar',
  assistantMessageToolbarCopyCodeLabel: 'Copiar',
  assistantMessageToolbarCopyCodeCopiedLabel: 'Copiado',
  assistantMessageToolbarThumbsUpLabel: 'Buena respuesta',
  assistantMessageToolbarThumbsDownLabel: 'Mala respuesta',
  assistantMessageToolbarRegenerateLabel: 'Regenerar',
  userMessageToolbarCopyMessageLabel: 'Copiar',
  userMessageToolbarEditMessageLabel: 'Editar',
  chatDisclaimerText: 'El asistente puede equivocarse. Verificá la información importante.',
  chatScrollToBottomLabel: 'Ir al final',
  chatConnectingLabel: 'Cargando conversación',
  welcomeMessageText: '¿En qué te puedo ayudar?',
  reasoningMessageThinkingLabel: 'Pensando…',
};
