import { useRef } from 'react';
import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from 'react';
import { cx } from './cx';
import { IconCheck, IconChevronDown } from './icons';

// ---------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * The change is being applied: the switch keeps showing the confirmed value and ignores input.
   * It stays focusable (`aria-disabled`), so toggling from the keyboard doesn't lose focus.
   */
  pending?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

export function Switch({ checked, onChange, disabled = false, pending = false, id, ...aria }: SwitchProps) {
  const busy = pending && !disabled;
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="sp-switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      aria-disabled={busy || undefined}
      data-pending={pending || undefined}
      disabled={disabled}
      onClick={() => {
        if (!busy) onChange(!checked);
      }}
      {...aria}
    >
      <span className="sp-switch__thumb" />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------------------------

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, description, disabled = false, className }: CheckboxProps) {
  return (
    <label className={cx('sp-check', className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="sp-check__box" aria-hidden="true">
        <IconCheck size={12} strokeWidth={2.25} />
      </span>
      <span className="sp-check__text">
        <span className="sp-check__label">{label}</span>
        {description ? <span className="sp-check__description">{description}</span> : null}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------------------------
// Text input & select
// ---------------------------------------------------------------------------------------------

export interface TextInputProps extends ComponentPropsWithRef<'input'> {
  inputSize?: 'sm' | 'md';
  mono?: boolean;
  invalid?: boolean;
}

export function TextInput({ inputSize = 'md', mono = false, invalid = false, className, ...rest }: TextInputProps) {
  return (
    <input
      className={cx('sp-input', inputSize === 'sm' && 'sp-input--sm', mono && 'sp-input--mono', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string>
  extends Omit<ComponentPropsWithRef<'select'>, 'value' | 'onChange' | 'children'> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  selectSize?: 'sm' | 'md';
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  selectSize = 'md',
  className,
  style,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={cx('sp-select-wrap', className)} style={style}>
      <select
        className={cx('sp-select', selectSize === 'sm' && 'sp-select--sm')}
        value={value}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.currentTarget.value);
          if (next) onChange(next.value);
        }}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={14} className="sp-select-wrap__icon" />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------------------------

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  errorId?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, errorId, children, className }: FieldProps) {
  return (
    <div className={cx('sp-field', className)}>
      <label className="sp-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="sp-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="sp-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Segmented control (radio group)
// ---------------------------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabled = options.filter((option) => !option.disabled);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const current = enabled.findIndex((option) => option.value === value);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (current - 1 + enabled.length) % enabled.length;
    else next = (current + 1) % enabled.length;
    const target = enabled[next];
    if (!target) return;
    onChange(target.value);
    const index = options.indexOf(target);
    refs.current[index]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cx('sp-seg', className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled || option.disabled}
            className="sp-seg__item"
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
