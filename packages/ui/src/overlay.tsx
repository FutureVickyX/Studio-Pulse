import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { cx } from './cx';
import { IconClose } from './icons';

// ---------------------------------------------------------------------------------------------
// Positioning helper
// ---------------------------------------------------------------------------------------------

const VIEWPORT_MARGIN = 8;

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'right' | 'top';

/**
 * Place a floating box of `size` next to `anchor`, flipping and clamping so it never leaves the
 * viewport (the indicator window is only 320 x 204).
 */
export function placeFloating(
  anchor: AnchorRect,
  size: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  gap = 4,
): { top: number; left: number } {
  let top: number;
  let left: number;
  switch (placement) {
    case 'right':
      left = anchor.right + gap;
      top = anchor.top + (anchor.bottom - anchor.top) / 2 - size.height / 2;
      if (left + size.width > viewport.width - VIEWPORT_MARGIN) left = anchor.left - gap - size.width;
      break;
    case 'top':
      top = anchor.top - gap - size.height;
      left = anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2;
      if (top < VIEWPORT_MARGIN) top = anchor.bottom + gap;
      break;
    case 'top-start':
      top = anchor.top - gap - size.height;
      left = anchor.left;
      if (top < VIEWPORT_MARGIN) top = anchor.bottom + gap;
      break;
    case 'bottom-end':
      top = anchor.bottom + gap;
      left = anchor.right - size.width;
      if (top + size.height > viewport.height - VIEWPORT_MARGIN) top = anchor.top - gap - size.height;
      break;
    case 'bottom-start':
    default:
      top = anchor.bottom + gap;
      left = anchor.left;
      if (top + size.height > viewport.height - VIEWPORT_MARGIN) top = anchor.top - gap - size.height;
      break;
  }
  const maxLeft = viewport.width - VIEWPORT_MARGIN - size.width;
  const maxTop = viewport.height - VIEWPORT_MARGIN - size.height;
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop)),
  };
}

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

// ---------------------------------------------------------------------------------------------
// Dialog (native <dialog>, modal)
// ---------------------------------------------------------------------------------------------

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Left-aligned footer content (status text, secondary actions). */
  footerStart?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** False while an action runs: Escape and backdrop clicks are ignored. */
  dismissible?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  size = 'sm',
  dismissible = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={cx('sp-dialog', size !== 'sm' && `sp-dialog--${size}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Escape: keep the dialog controlled by React state.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        // A click whose target is the <dialog> itself landed on the backdrop.
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      {open ? (
        <div className="sp-dialog__inner">
          <header className="sp-dialog__header">
            <div>
              <h2 className="sp-dialog__title" id={titleId}>
                {title}
              </h2>
              {description ? (
                <p className="sp-dialog__description" id={descriptionId}>
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="sp-btn sp-btn--ghost sp-btn--icon sp-btn--sm"
              aria-label="Close"
              title="Close"
              disabled={!dismissible}
              onClick={onClose}
            >
              <IconClose size={14} />
            </button>
          </header>
          {children != null ? <div className="sp-dialog__body">{children}</div> : null}
          {footer || footerStart ? (
            <footer className="sp-dialog__footer">
              {footerStart ? <div className="sp-dialog__footer-start">{footerStart}</div> : null}
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu button
// ---------------------------------------------------------------------------------------------

export interface MenuItem {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** Render the trigger button and spread `props` onto it. */
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: ReadonlyArray<MenuItem>;
  /** Small heading inside the menu. */
  label?: ReactNode;
  /** Accessible name for the menu. */
  'aria-label': string;
  placement?: Placement;
}

export function Menu({ trigger, items, label, placement = 'bottom-start', 'aria-label': ariaLabel }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusFirst = useRef<'first' | 'last'>('first');
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    setPosition(
      placeFloating(anchor, { width: menu.offsetWidth, height: menu.offsetHeight }, placement, viewportSize()),
    );
  }, [open, placement]);

  useEffect(() => {
    if (!open || !position) return;
    const enabled = itemRefs.current.filter((node): node is HTMLButtonElement => !!node && !node.disabled);
    const target = focusFirst.current === 'first' ? enabled[0] : enabled[enabled.length - 1];
    target?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    }
    function onBlurWindow() {
      close(false);
    }
    function onResize() {
      close(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlurWindow);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlurWindow);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  function openMenu(focus: 'first' | 'last') {
    focusFirst.current = focus;
    setOpen(true);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu('last');
    }
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const enabled = itemRefs.current.filter((node): node is HTMLButtonElement => !!node && !node.disabled);
    const index = enabled.findIndex((node) => node === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (enabled.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = enabled[(index + delta + enabled.length) % enabled.length];
      next?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
      next?.focus();
    }
  }

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => (open ? close(false) : openMenu('first')),
        onKeyDown: onTriggerKeyDown,
      })}
      {open
        ? (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              className="sp-menu"
              style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' }}
              onKeyDown={onMenuKeyDown}
            >
              {label ? (
                <div className="sp-menu__label" aria-hidden="true">
                  {label}
                </div>
              ) : null}
              {items.map((item, index) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  className={cx('sp-menu__item', item.danger && 'sp-menu__item--danger')}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.icon ? <span className="sp-menu__item-icon">{item.icon}</span> : null}
                  <span className="sp-menu__item-label">{item.label}</span>
                  {item.hint ? <span className="sp-menu__item-hint">{item.hint}</span> : null}
                </button>
              ))}
            </div>
          )
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tooltip (visual only: put the same information in the control's accessible name)
// ---------------------------------------------------------------------------------------------

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: Placement;
  /** Delay before showing, ms. */
  delay?: number;
}

export function Tooltip({ content, children, placement = 'top', delay = 350 }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setVisible(false);
    setPosition(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!visible) return;
    const target = anchorRef.current?.firstElementChild ?? anchorRef.current;
    const tip = tipRef.current;
    if (!target || !tip) return;
    setPosition(
      placeFloating(
        target.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        placement,
        viewportSize(),
        6,
      ),
    );
  }, [visible, placement]);

  return (
    <span
      ref={anchorRef}
      className="sp-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && visible) hide();
      }}
    >
      {children}
      {visible
        ? (
            <div
              ref={tipRef}
              className="sp-tooltip"
              aria-hidden="true"
              style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' }}
            >
              {content}
            </div>
          )
        : null}
    </span>
  );
}
