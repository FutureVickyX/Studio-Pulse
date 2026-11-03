/**
 * Short confirmations and failures after an action ("Task created", "Couldn't archive…"),
 * announced politely to screen readers. Failures stay until dismissed.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { IconAlertCircle, IconCheckCircle, IconClose } from '@studio-pulse/ui';

import type { Problem } from '../lib/errors';

export interface Notice {
  readonly id: number;
  readonly tone: 'success' | 'danger';
  readonly message: string;
}

let notices: readonly Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissNotice(id: number): void {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

function push(tone: Notice['tone'], message: string, ttlMs: number | null): void {
  const id = nextId++;
  notices = [...notices.slice(-3), { id, tone, message }];
  emit();
  if (ttlMs !== null) setTimeout(() => dismissNotice(id), ttlMs);
}

export function notifySuccess(message: string): void {
  push('success', message, 3_500);
}

export function notifyProblem(problem: Problem, prefix?: string): void {
  push('danger', prefix ? `${prefix} ${problem.message}` : problem.message, null);
}

function isOpenModal(dialog: HTMLDialogElement): boolean {
  if (!dialog.isConnected || !dialog.open) return false;
  try {
    return dialog.matches(':modal');
  } catch {
    return true; // a browser without :modal; Dialog only ever opens with showModal()
  }
}

/**
 * The topmost open modal <dialog>, or null. Everything outside it is inert, so a notice raised
 * while it is open would sit under the backdrop: not visible, not clickable, not announced.
 */
function useTopModalDialog(): HTMLDialogElement | null {
  const [top, setTop] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    // In opening order: the last one still open is on top of the top layer.
    const stack: HTMLDialogElement[] = [];
    const update = () => {
      for (let i = stack.length - 1; i >= 0; i -= 1) if (!isOpenModal(stack[i]!)) stack.splice(i, 1);
      for (const dialog of document.querySelectorAll('dialog')) {
        if (!stack.includes(dialog) && isOpenModal(dialog)) stack.push(dialog);
      }
      setTop(stack.at(-1) ?? null);
    };
    // showModal() and close() set and remove the open attribute; a removed dialog leaves the top layer.
    const observer = new MutationObserver((records) => {
      const relevant = records.some((r) =>
        r.type === 'attributes' ? r.target instanceof HTMLDialogElement : stack.length > 0 && r.removedNodes.length > 0,
      );
      if (relevant) update();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    update();
    return () => observer.disconnect();
  }, []);
  return top;
}

export function Notices() {
  const list = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
  );
  const dialog = useTopModalDialog();
  // The page's own region always stays mounted, so a notice raised as a dialog closes is still
  // announced. While a modal dialog is open (and the page inert), the same notices also show
  // inside it, at the same fixed position, over the page's copy.
  return (
    <>
      <NoticeList list={list} />
      {dialog ? createPortal(<NoticeList list={list} />, dialog) : null}
    </>
  );
}

function NoticeList({ list }: { list: readonly Notice[] }) {
  return (
    <div className="web-notices" role="status" aria-live="polite">
      {list.map((notice) => (
        <div key={notice.id} className={`web-notice web-notice--${notice.tone}`}>
          <span className="web-notice__icon" aria-hidden="true">
            {notice.tone === 'success' ? <IconCheckCircle size={16} /> : <IconAlertCircle size={16} />}
          </span>
          <span className="web-notice__text">{notice.message}</span>
          <button type="button" className="web-notice__close" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
