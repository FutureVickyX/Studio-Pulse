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
  /**
   * Shows a spinner in place of the icon and blocks activation while an action runs. The button
   * stays focusable (`aria-disabled`, not `disabled`), so keyboard focus is not dropped to the
   * page body mid-action — inside a modal dialog that would strand the user.
   */
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
  onClick,
  ...rest
}: ButtonProps) {
  const busy = pending && !disabled;
  return (
    <button
      type={type}
      className={cx('sp-btn', `sp-btn--${variant}`, size === 'sm' && 'sp-btn--sm', className)}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={pending || undefined}
      {...rest}
      onClick={(event) => {
        if (busy) {
          // Also stops a pending submit button from submitting its form again.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
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
