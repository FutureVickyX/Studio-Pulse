import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './cx';

export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  return (
    <span
      className="sp-spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  /** Shows a spinner in place of the icon and blocks clicks while an action runs. */
  pending?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconAfter,
  pending = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('sp-btn', `sp-btn--${variant}`, size === 'sm' && 'sp-btn--sm', className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <Spinner size={size === 'sm' ? 11 : 12} /> : icon}
      {children != null && children !== false ? <span>{children}</span> : null}
      {iconAfter}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconAfter'> {
  /** Accessible name; also shown as the native tooltip. */
  label: string;
  icon: ReactNode;
}

export function IconButton({ label, icon, variant = 'ghost', className, title, ...rest }: IconButtonProps) {
  return (
    <Button
      variant={variant}
      className={cx('sp-btn--icon', className)}
      aria-label={label}
      title={title ?? label}
      icon={icon}
      {...rest}
    />
  );
}
