import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import {
  Badge,
  BrandMark,
  Button,
  Dialog,
  IconClock,
  IconHome,
  IconKeyboard,
  IconNotes,
  IconProjects,
  IconSettings,
  IconTasks,
  IconTeam,
  Kbd,
  SkeletonLines,
  Tooltip,
} from '@studio-pulse/ui';
import type { ReactNode } from 'react';
import { ErrorBanner, ErrorBoundary, LiveDuration, StatusLabel } from '../components/common';
import { PauseControl } from '../components/PauseControl';
import { useTrackerActions, useTrackerStatus } from '../hooks/useLive';
import { subscribe } from '../lib/api';
import { clockTime } from '../lib/format';
import { matchShortcut, SHORTCUTS } from '../lib/keyboard';
import { isRoute, NAV_ITEMS, resolveNavigation, sectionOf, settingsTabOf } from '../lib/routes';
import type { Section } from '../lib/routes';
import { describeStatus, hasLiveSession, pauseAction } from '../lib/status';
import { trackerStatusStore } from '../lib/stores';
import { HomeView } from '../views/HomeView';
import { SettingsView } from '../views/settings/SettingsView';
import { TimeView } from '../views/TimeView';

const NAV_ICONS: Readonly<Record<Section, ReactNode>> = {
  home: <IconHome size={16} />,
  tasks: <IconTasks size={16} />,
  notes: <IconNotes size={16} />,
  projects: <IconProjects size={16} />,
  time: <IconClock size={16} />,
  team: <IconTeam size={16} />,
  settings: <IconSettings size={16} />,
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(target.type);
  }
  return false;
}

export function Shell() {
  const [route, setRoute] = useState<Route>('home');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const pauseActions = useTrackerActions();

  const navigate = useCallback((requested: Route) => {
    setRoute((current) => resolveNavigation(current, requested));
  }, []);

  // A new section starts at the top of the page.
  const section = sectionOf(route);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [section]);

  // Rust → UI navigation (tray menu, "Open Studio Pulse" from the indicator).
  useEffect(
    () =>
      subscribe('app://navigate', (payload) => {
        if (isRoute(payload)) navigate(payload);
      }),
    [navigate],
  );

  const { pause, resume } = pauseActions;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const action = matchShortcut(event, {
        typing: isTypingTarget(event.target),
        modalOpen: document.querySelector('dialog[open]') !== null,
      });
      if (!action) return;
      event.preventDefault();
      if (action.type === 'navigate') navigate(action.route);
      else if (action.type === 'showShortcuts') setShortcutsOpen(true);
      else {
        const state = trackerStatusStore.getSnapshot().data?.state;
        if (!state) return;
        const mode = pauseAction(state);
        if (mode === 'resume') void resume();
        else if (mode === 'pause') void pause(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, pause, resume]);

  const settingsTab = settingsTabOf(route);

  return (
    <div className="app-shell">
      <Sidebar route={route} onNavigate={navigate} onShowShortcuts={() => setShortcutsOpen(true)} shortcutError={pauseActions.error?.message ?? null} />
      <main className="app-main" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary key={section} label="This page">
          {section === 'home' ? <HomeView onNavigate={navigate} /> : null}
          {section === 'time' ? <TimeView /> : null}
          {section === 'settings' && settingsTab ? <SettingsView tab={settingsTab} onNavigate={navigate} /> : null}
        </ErrorBoundary>
      </main>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

function Sidebar({
  route,
  onNavigate,
  onShowShortcuts,
  shortcutError,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  onShowShortcuts: () => void;
  shortcutError: string | null;
}) {
  const section = sectionOf(route);
  return (
    <aside className="app-sidebar" aria-label="Studio Pulse">
      <div className="app-brand">
        <BrandMark size={22} />
        <span className="app-brand__name">Studio Pulse</span>
      </div>

      <TrackingCard shortcutError={shortcutError} />

      <nav className="app-nav" aria-label="Sections">
        <ul>
          {NAV_ITEMS.map((item) => {
            const current = item.section === section;
            if (!item.available) {
              return (
                <li key={item.section}>
                  <Tooltip content="Arrives in Phase 2" placement="right">
                    <button
                      type="button"
                      className="app-nav__item"
                      aria-disabled="true"
                      onClick={(event) => event.preventDefault()}
                    >
                      <span className="app-nav__icon">{NAV_ICONS[item.section]}</span>
                      <span className="app-nav__label">{item.label}</span>
                      <Badge tone="subtle" className="app-nav__tag">
                        Phase 2
                      </Badge>
                      <span className="sp-visually-hidden">, arrives in Phase 2</span>
                    </button>
                  </Tooltip>
                </li>
              );
            }
            return (
              <li key={item.section}>
                <button
                  type="button"
                  className="app-nav__item"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onNavigate(item.section)}
                  title={`${item.label} (Ctrl+${item.digit})`}
                >
                  <span className="app-nav__icon">{NAV_ICONS[item.section]}</span>
                  <span className="app-nav__label">{item.label}</span>
                  <span className="app-nav__kbd" aria-hidden="true">
                    Ctrl {item.digit}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="app-sidebar__footer">
        <Button size="sm" variant="ghost" icon={<IconKeyboard size={14} />} onClick={onShowShortcuts} className="app-sidebar__shortcuts">
          Shortcuts
          <Kbd>?</Kbd>
        </Button>
        <span className="app-sidebar__local" title="Nothing leaves this device in this version">
          Local only
        </span>
      </div>
    </aside>
  );
}

/** Sidebar status card. The live counter is isolated in <LiveDuration>. */
function TrackingCard({ shortcutError }: { shortcutError: string | null }) {
  const { data: status, error, reload } = useTrackerStatus();
  if (!status) {
    return (
      <section className="app-track" aria-label="Tracking status">
        {error ? (
          <ErrorBanner title="Status unavailable" error={error} onRetry={() => void reload()} />
        ) : (
          <SkeletonLines lines={3} label="Loading tracking status" />
        )}
      </section>
    );
  }
  const presentation = describeStatus(status, { formatTime: (ms) => clockTime(ms, currentTimeZone()) });
  const live = hasLiveSession(status) ? status.current : null;
  return (
    <section className="app-track" data-state={status.state} aria-label="Tracking status">
      <StatusLabel presentation={presentation} />
      <p className="app-track__app sp-truncate" title={presentation.headline}>
        {live ? live.applicationName : presentation.headline}
      </p>
      {live ? (
        <LiveDuration startedAt={live.startedAt} className="app-track__clock sp-num" />
      ) : (
        <p className="app-track__hint">{presentation.explanation}</p>
      )}
      <div className="app-track__actions">
        <PauseControl state={status.state} size="sm" className="app-track__button" />
      </div>
      {shortcutError ? (
        <p className="app-inline-error" role="alert">
          {shortcutError}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shortcuts sheet
// ---------------------------------------------------------------------------------------------

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <dl className="app-shortcuts">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys.join('+') + shortcut.description} className="app-shortcuts__row">
            <dt>{shortcut.description}</dt>
            <dd>
              {shortcut.keys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? <span className="app-shortcuts__plus">+</span> : null}
                  <Kbd>{key}</Kbd>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="app-dialog-text sp-faint">Tasks, Notes, Projects and Team (Ctrl+2, 3, 4, 6) arrive in Phase 2.</p>
    </Dialog>
  );
}
