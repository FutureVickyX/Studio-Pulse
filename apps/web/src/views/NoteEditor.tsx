/**
 * Edit one note with autosave (lib/autosave.ts): "Saved" means the server confirmed it; text that
 * could not be saved stays on this device and is offered back; a teammate's newer save is never
 * overwritten without a choice.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Banner, Button, Card, EmptyState, IconChevronLeft, IconTrash, SegmentedControl, Spinner, Switch, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { AutosaveController, draftStore } from '../lib/autosave';
import type { AutosaveSnapshot, StoredDraft } from '../lib/autosave';
import { canEditNote, canManageProjects } from '../lib/model';
import type { Note, NoteVisibility } from '../lib/model';
import { formatClock, formatRelative, formatWhen } from '../lib/format';
import { setQueryData } from '../lib/store';
import { ConfirmDialog, LoadingRows, ProblemBanner, ProjectSelect, useAction } from '../components/common';
import { notifyProblem, notifySuccess } from '../components/notices';
import { keys, useNotes, useProjects, useRefresh, useWorkspace } from '../app/workspace';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function NoteEditor({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const notes = useNotes();
  const note = notes.data?.find((n) => n.id === noteId);
  if (notes.data === undefined) {
    return <Card>{notes.problem ? <ProblemBanner problem={notes.problem} onRetry={() => void notes.reload()} /> : <LoadingRows rows={6} />}</Card>;
  }
  if (!note) return <MissingNote noteId={noteId} onClose={onClose} />;
  return <Editor key={note.id} note={note} onClose={onClose} />;
}

/** Deleted, made private by its owner, or never shared: say so, and hand back unsaved text. */
function MissingNote({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const { user } = useWorkspace();
  const store = useMemo(() => draftStore(storage(), user.id, noteId), [user.id, noteId]);
  const [draft, setDraft] = useState(() => store.read());
  return (
    <Card>
      <EmptyState
        title="This note isn’t available"
        action={
          <Button icon={<IconChevronLeft size={14} />} onClick={onClose}>
            All notes
          </Button>
        }
      >
        It was deleted, or its owner made it private.
      </EmptyState>
      {draft ? (
        <Banner tone="warning" title="Unsaved text from this device">
          <p>Copy it before you discard it:</p>
          <textarea className="sp-input web-textarea" rows={6} readOnly value={`${draft.title}\n\n${draft.body}`} aria-label="Unsaved text" />
          <Button
            size="sm"
            onClick={() => {
              store.write(null, 0, Date.now());
              setDraft(null);
            }}
          >
            Discard it
          </Button>
        </Banner>
      ) : null}
    </Card>
  );
}

function Editor({ note, onClose }: { note: Note; onClose: () => void }) {
  const { client, workspace, user, memberName } = useWorkspace();
  const refresh = useRefresh();
  const projects = useProjects();
  const action = useAction();
  const editable = canEditNote(note, user.id);
  const owner = note.owner_id === user.id;
  const store = useMemo(() => draftStore(storage(), user.id, note.id), [user.id, note.id]);
  const [recovered, setRecovered] = useState<StoredDraft | null>(() => {
    const draft = store.read();
    return draft && (draft.title !== note.title || draft.body !== note.body) ? draft : null;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The setting being changed (one at a time). Every control stays focusable meanwhile and
  // ignores input, so keyboard focus is never dropped.
  const [metaPending, setMetaPending] = useState<keyof api.NoteMetaPatch | null>(null);
  const metaBusy = useRef(false);

  // One controller per note (this view is keyed by note id); a newer server version is handed in
  // through `receive` below.
  const newController = () =>
    new AutosaveController({ title: note.title, body: note.body }, note.version, {
      save: (draft, baseVersion) => api.saveNoteText(client, note.id, draft, baseVersion),
      storeDraft: (draft, baseVersion) => store.write(draft, baseVersion, Date.now()),
    });
  const [controller, setController] = useState(newController);
  const snapshot: AutosaveSnapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // The controller lives as long as this effect: unmount (another note, another page) sends what
  // is pending and stops timers. StrictMode (development) unmounts and mounts once more right
  // away; the controller disposed in between is replaced, or typing would be ignored.
  useEffect(() => {
    if (controller.isDisposed()) {
      setController(newController());
      return undefined;
    }
    return () => controller.dispose();
  }, [controller]);

  // A teammate's newer save arrived (realtime or refetch).
  useEffect(() => {
    controller.receive({ title: note.title, body: note.body }, note.version);
  }, [controller, note.title, note.body, note.version]);

  // Keep the list in step with what the server confirmed.
  useEffect(() => {
    if (snapshot.status !== 'saved' || snapshot.version <= note.version) return;
    setQueryData<Note[]>(keys.notes(workspace.id), (list) =>
      (list ?? []).map((n) =>
        n.id === note.id
          ? { ...n, title: snapshot.draft.title, body: snapshot.draft.body, version: snapshot.version, updated_at: new Date().toISOString() }
          : n,
      ),
    );
  }, [snapshot.status, snapshot.version, snapshot.draft, note.id, note.version, workspace.id]);

  // Leaving the page with unsaved text: ask first.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [controller]);

  async function updateMeta(patch: api.NoteMetaPatch, success?: string) {
    if (metaBusy.current) return;
    metaBusy.current = true;
    setMetaPending((Object.keys(patch) as (keyof api.NoteMetaPatch)[])[0] ?? null);
    try {
      // After the pending text is saved and never alongside a save; the autosave builds on the
      // version this creates.
      const result = await action.run(() =>
        controller.writeBetween(
          (version) => api.updateNoteMeta(client, note.id, version, patch),
          (outcome) => (outcome.status === 'saved' ? outcome.row.version : null),
        ),
      );
      if (result?.status === 'saved') {
        const row = result.row;
        setQueryData<Note[]>(keys.notes(workspace.id), (list) => (list ?? []).map((n) => (n.id === row.id && n.version <= row.version ? row : n)));
        if (success) notifySuccess(success);
      } else if (result?.status === 'conflict') {
        notifyProblem({ kind: 'conflict', message: 'Someone saved this note a moment ago. Try again.' });
      }
    } finally {
      metaBusy.current = false;
      setMetaPending(null);
    }
    refresh('notes');
  }

  async function remove(): Promise<boolean> {
    const done = await action.run(() => api.deleteNote(client, note.id), 'Note deleted.', 'Couldn’t delete:');
    if (done === undefined) return false;
    store.write(null, 0, Date.now());
    refresh('notes');
    onClose();
    return true;
  }

  const draft = snapshot.draft;
  const archived = note.archived_at !== null;

  return (
    <Card className="web-editor">
      <div className="web-editor__bar">
        <button type="button" className="web-back web-back--inline" onClick={onClose}>
          <IconChevronLeft size={14} /> Notes
        </button>
        <SaveStatus snapshot={snapshot} onRetry={() => void controller.flush()} />
      </div>

      {recovered ? (
        <Banner
          tone="info"
          title="Unsaved changes from this device"
          action={
            <>
              <Button
                size="sm"
                onClick={() => {
                  // Written on top of an older version: shown as a conflict with the current text.
                  controller.restore({ title: recovered.title, body: recovered.body }, recovered.baseVersion);
                  setRecovered(null);
                }}
              >
                Restore them
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  store.write(null, 0, Date.now());
                  setRecovered(null);
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          {recovered.baseVersion < snapshot.version
            ? 'Text you typed here wasn’t saved to the workspace, and the note was saved since. Restoring shows both versions so you can choose.'
            : 'Text you typed here wasn’t saved to the workspace. Restoring replaces the current text.'}
        </Banner>
      ) : null}

      {snapshot.status === 'conflict' ? (
        <Banner
          tone="warning"
          title="Someone else saved this note"
          action={
            <>
              <Button size="sm" onClick={() => void controller.keepMine()}>
                Keep my version
              </Button>
              <Button size="sm" variant="ghost" onClick={() => controller.takeTheirs()} disabled={!snapshot.server}>
                Use theirs
              </Button>
            </>
          }
        >
          Your latest changes were not saved over theirs.
          {snapshot.server ? ' Keeping yours replaces their version; using theirs discards your unsaved changes.' : ''}
        </Banner>
      ) : null}
      {snapshot.status === 'gone' && snapshot.problem ? <Banner tone="danger">{snapshot.problem.message}</Banner> : null}

      <TextInput
        className="web-editor__title"
        aria-label="Title"
        placeholder="Untitled note"
        value={draft.title}
        readOnly={!editable}
        maxLength={200}
        onChange={(e) => controller.edit({ title: e.currentTarget.value, body: draft.body })}
        onBlur={() => void controller.flush()}
      />
      <textarea
        className="sp-input web-editor__body"
        aria-label="Note"
        placeholder={editable ? 'Write in plain text or Markdown…' : ''}
        value={draft.body}
        readOnly={!editable}
        onChange={(e) => controller.edit({ title: draft.title, body: e.currentTarget.value })}
        onBlur={() => void controller.flush()}
      />

      <div className="web-editor__meta">
        {owner ? (
          <>
            <SegmentedControl<NoteVisibility>
              aria-label="Who can see this note"
              value={note.visibility}
              onChange={(visibility) =>
                void updateMeta({ visibility }, visibility === 'private' ? 'Now private to you.' : 'Shared with the workspace.')
              }
              options={[
                { value: 'private', label: 'Private' },
                { value: 'workspace', label: 'Shared' },
              ]}
            />
            <ProjectSelect
              size="sm"
              label="Project"
              projects={projects.data ?? []}
              value={note.project_id}
              onChange={(project_id) => void updateMeta({ project_id })}
            />
            <label className="web-switch">
              <Switch
                checked={note.pinned}
                pending={metaPending === 'pinned'}
                onChange={(pinned) => void updateMeta({ pinned })}
                aria-label="Pin this note"
              />
              <span>Pinned</span>
            </label>
            <Button
              size="sm"
              pending={metaPending === 'archived_at'}
              onClick={() =>
                void updateMeta(
                  { archived_at: archived ? null : new Date().toISOString() },
                  archived ? 'Note restored.' : 'Note archived.',
                )
              }
            >
              {archived ? 'Restore' : 'Archive'}
            </Button>
          </>
        ) : (
          <span className="web-footnote">
            {note.visibility === 'workspace' ? 'Shared note' : 'Private note'} by {memberName(note.owner_id)}.
            {editable ? ' You can edit the text; its owner decides sharing, project, pin and archive.' : ''}
          </span>
        )}
        {owner || (note.visibility === 'workspace' && canManageProjects(workspace.role)) ? (
          <Button size="sm" variant="ghost" icon={<IconTrash size={14} />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        ) : null}
        <span className="web-editor__stamp">
          Created {formatWhen(note.created_at)} · updated {formatRelative(note.updated_at)}
        </span>
      </div>

      <ConfirmDialog open={confirmDelete} title="Delete this note?" confirmLabel="Delete note" danger onClose={() => setConfirmDelete(false)} onConfirm={remove}>
        <p className="web-dialog-text">
          {note.visibility === 'workspace' ? 'It disappears for everyone in the workspace. ' : ''}This can’t be undone. Archive it instead to keep it out of the way.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function SaveStatus({ snapshot, onRetry }: { snapshot: AutosaveSnapshot; onRetry: () => void }) {
  switch (snapshot.status) {
    case 'saved':
      return <span className="web-save web-save--ok">{snapshot.lastSavedAt ? `Saved ${formatClock(new Date(snapshot.lastSavedAt).toISOString())}` : 'Saved'}</span>;
    case 'dirty':
      return <span className="web-save">Unsaved changes</span>;
    case 'saving':
      return (
        <span className="web-save">
          <Spinner size={10} /> Saving…
        </span>
      );
    case 'error':
      return (
        <span className="web-save web-save--error" role="status">
          Not saved — {snapshot.problem?.kind === 'network' ? 'offline. Retrying; your text is kept on this device.' : (snapshot.problem?.message ?? 'retrying.')}
          <button type="button" className="web-link" onClick={onRetry}>
            Retry now
          </button>
        </span>
      );
    case 'conflict':
      return <span className="web-save web-save--error">Not saved — changed by someone else</span>;
    case 'gone':
      return <span className="web-save web-save--error">Not saved</span>;
  }
}
