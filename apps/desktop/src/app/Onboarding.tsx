import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { APP_CATEGORIES, APP_CATEGORY_LABELS } from '@studio-pulse/shared-types';
import type { ApplicationDefinition, Settings } from '@studio-pulse/shared-types';
import { Banner, BrandMark, Button, Checkbox, IconChevronLeft, IconChevronRight, IconShield, SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner, InlineError } from '../components/common';
import { storeSettings, useApplications } from '../hooks/useLive';
import { useStartupStatus } from '../hooks/useStartupStatus';
import { call, toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { RecordedLists } from '../views/settings/PrivacySettings';
import { LaunchAtLoginSetting, SwitchSetting, useSettingsPatcher } from '../views/settings/shared';

type Step = 'welcome' | 'applications' | 'startup' | 'finish';

const STEPS: ReadonlyArray<{ step: Step; label: string }> = [
  { step: 'welcome', label: 'Welcome' },
  { step: 'applications', label: 'Applications' },
  { step: 'startup', label: 'Startup' },
  { step: 'finish', label: 'Finish' },
];

/** First run. Tracking has not started; it starts only when the user finishes here. */
export function Onboarding({ settings }: { settings: Settings }) {
  const [step, setStep] = useState<Step>('welcome');
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const applications = useApplications();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const index = STEPS.findIndex((item) => item.step === step);

  // Pre-check from each application's current `enabled` flag, once they load.
  useEffect(() => {
    if (selected === null && applications.data) {
      setSelected(new Set(applications.data.filter((app) => app.enabled).map((app) => app.id)));
    }
  }, [applications.data, selected]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<ApiError | null>(null);

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      // Only ids that exist in the registry are sent.
      const ids = (applications.data ?? []).filter((app) => selected?.has(app.id)).map((app) => app.id);
      storeSettings(await call('complete_onboarding', { enabledApplicationIds: ids }));
    } catch (caught) {
      setFinishError(toCommandError(caught));
      setFinishing(false);
    }
  }

  const go = (offset: number) => {
    const next = STEPS[index + offset];
    if (next) setStep(next.step);
  };

  return (
    <div className="app-onboarding">
      <div className="app-onboarding__card" role="region" aria-label="Set up Studio Pulse">
        <header className="app-onboarding__header">
          <BrandMark size={28} />
          <ol className="app-steps" aria-label="Setup steps">
            {STEPS.map((item, itemIndex) => (
              <li
                key={item.step}
                className="app-steps__item"
                data-state={itemIndex < index ? 'done' : itemIndex === index ? 'current' : 'todo'}
                aria-current={itemIndex === index ? 'step' : undefined}
              >
                <span className="app-steps__dot" aria-hidden="true" />
                <span className="app-steps__label">{item.label}</span>
              </li>
            ))}
          </ol>
        </header>

        <div className="app-onboarding__body">
          {step === 'welcome' ? <WelcomeStep headingRef={headingRef} /> : null}
          {step === 'applications' ? (
            <ApplicationsStep
              headingRef={headingRef}
              applications={applications.data}
              error={applications.error}
              onRetry={() => void applications.reload()}
              selected={selected ?? new Set()}
              onChange={setSelected}
            />
          ) : null}
          {step === 'startup' ? <StartupStep headingRef={headingRef} settings={settings} /> : null}
          {step === 'finish' ? (
            <FinishStep headingRef={headingRef} selected={selected ?? new Set()} applications={applications.data ?? []} />
          ) : null}
        </div>

        <InlineError error={finishError} />
        <footer className="app-onboarding__footer">
          {index > 0 ? (
            <Button variant="ghost" icon={<IconChevronLeft size={14} />} disabled={finishing} onClick={() => go(-1)}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {step === 'finish' ? (
            <Button variant="primary" pending={finishing} onClick={() => void finish()}>
              Start tracking
            </Button>
          ) : (
            <Button
              variant="primary"
              iconAfter={<IconChevronRight size={14} />}
              disabled={step === 'applications' && !applications.data}
              onClick={() => go(1)}
            >
              {step === 'welcome' ? 'Get started' : 'Continue'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

type HeadingRef = RefObject<HTMLHeadingElement | null>;

function StepHeading({ headingRef, title, text }: { headingRef: HeadingRef; title: string; text?: string }) {
  return (
    <div className="app-onboarding__intro">
      <h1 className="app-onboarding__title" ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {text ? <p className="app-onboarding__text">{text}</p> : null}
    </div>
  );
}

function WelcomeStep({ headingRef }: { headingRef: HeadingRef }) {
  return (
    <>
      <StepHeading
        headingRef={headingRef}
        title="Welcome to Studio Pulse"
        text="Studio Pulse notices which creative app you’re working in and separates active time from idle time, automatically. Here is exactly what that means."
      />
      <RecordedLists />
      <Banner tone="info" compact>
        <span className="app-inline-icon">
          <IconShield size={14} />
        </span>
        Your data stays on this device unless you later sign in and choose a workspace to sync with. Nothing is
        recorded until you finish setup.
      </Banner>
    </>
  );
}

function ApplicationsStep({
  headingRef,
  applications,
  error,
  onRetry,
  selected,
  onChange,
}: {
  headingRef: HeadingRef;
  applications: ApplicationDefinition[] | undefined;
  error: ApiError | null;
  onRetry: () => void;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const groups = useMemo(
    () =>
      APP_CATEGORIES.map((category) => ({
        category,
        apps: (applications ?? [])
          .filter((app) => app.category === category)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName)),
      })).filter((group) => group.apps.length > 0),
    [applications],
  );

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  return (
    <>
      <StepHeading
        headingRef={headingRef}
        title="Which applications should be tracked?"
        text="Only these apps are recorded when they’re in front. You can change this any time in Settings › Applications, including adding your own."
      />
      {error && !applications ? <ErrorBanner title="Applications could not be loaded" error={error} onRetry={onRetry} /> : null}
      {!applications && !error ? <SkeletonLines lines={6} label="Loading applications" /> : null}
      {applications ? (
        <>
          <div className="app-select-bar">
            <span className="sp-muted" role="status">
              {plural(selected.size, 'application', 'applications')} selected
            </span>
            <Button size="sm" variant="ghost" onClick={() => onChange(new Set(applications.map((app) => app.id)))}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>
              Clear
            </Button>
          </div>
          <div className="app-app-grid">
            {groups.map((group) => (
              <fieldset key={group.category} className="app-app-grid__group">
                <legend>{APP_CATEGORY_LABELS[group.category]}</legend>
                {group.apps.map((app) => (
                  <Checkbox
                    key={app.id}
                    checked={selected.has(app.id)}
                    onChange={(on) => toggle(app.id, on)}
                    label={app.displayName}
                  />
                ))}
              </fieldset>
            ))}
          </div>
          {selected.size === 0 ? (
            <Banner tone="warning" compact>
              With no applications selected, nothing will be recorded until you turn some on in Settings.
            </Banner>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function StartupStep({ headingRef, settings }: { headingRef: HeadingRef; settings: Settings }) {
  const startup = useStartupStatus();
  const patcher = useSettingsPatcher();
  return (
    <>
      <StepHeading
        headingRef={headingRef}
        title="Start with Windows?"
        text="Tracking only works while Studio Pulse is running. Both options can be changed later in Settings › General."
      />
      <div className="app-onboarding__settings">
        <LaunchAtLoginSetting startup={startup} />
        <SwitchSetting
          title="Start minimized"
          description="When Windows starts Studio Pulse, stay in the system tray."
          checked={settings.general.startMinimized}
          pending={patcher.isPending('startMinimized')}
          error={patcher.errorFor('startMinimized')}
          onChange={(startMinimized) => void patcher.apply('startMinimized', { general: { startMinimized } })}
        />
      </div>
    </>
  );
}

function FinishStep({
  headingRef,
  selected,
  applications,
}: {
  headingRef: HeadingRef;
  selected: ReadonlySet<string>;
  applications: readonly ApplicationDefinition[];
}) {
  const names = applications.filter((app) => selected.has(app.id)).map((app) => app.displayName);
  const preview = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  return (
    <>
      <StepHeading
        headingRef={headingRef}
        title="Ready to start"
        text="Tracking starts as soon as you finish. Its status is always visible in the sidebar, the tray icon and the compact indicator."
      />
      <div className="app-finish">
        <p>
          <strong>{plural(names.length, 'application', 'applications')}</strong> will be tracked
          {names.length > 0 ? `: ${preview}.` : '.'}
        </p>
        <p className="sp-muted">Pause any time from the sidebar, the tray menu or with Ctrl+Shift+P.</p>
      </div>
    </>
  );
}
