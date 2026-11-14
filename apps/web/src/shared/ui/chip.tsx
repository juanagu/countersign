import type { ButtonHTMLAttributes } from 'react';
import './chip.css';

/** A pill-shaped suggestion or quick reply that sends a message when pressed. */
export function Chip({ className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className ? `chip ${className}` : 'chip'} {...props} />;
}
