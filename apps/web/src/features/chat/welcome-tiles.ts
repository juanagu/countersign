import type { IconName } from '../../shared/ui/icon';

export interface WelcomeTile {
  label: string;
  /** Sent as the user's message when the tile is chosen. */
  message: string;
  icon: IconName;
}

export const WELCOME_TILES: readonly WelcomeTile[] = [
  { label: 'Mis saldos', message: '¿Cuánto tengo en mis cuentas?', icon: 'wallet' },
  { label: 'Gastos del mes pasado', message: '¿En qué gasté el mes pasado?', icon: 'bars' },
  { label: 'Últimos movimientos', message: 'Mostrame mis últimos movimientos', icon: 'list' },
  { label: 'Transferir a un contacto', message: 'Quiero hacer una transferencia', icon: 'transfer' },
  { label: 'Costo de enviar dólares', message: '¿Cuánto cuesta una transferencia internacional?', icon: 'globe' },
  { label: 'Perdí mi tarjeta', message: 'Perdí mi tarjeta, ¿qué hago?', icon: 'card' },
];
