import type { ButtonHTMLAttributes } from 'react';
import './button.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
}

export function Button({ variant = 'primary', block = false, className, type = 'button', ...props }: ButtonProps) {
  const classes = ['button', `button--${variant}`, block ? 'button--block' : '', className ?? ''].filter(Boolean);
  return <button type={type} className={classes.join(' ')} {...props} />;
}
