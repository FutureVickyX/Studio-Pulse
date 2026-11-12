/** Notes: personal (private) and shared notes, optionally tied to a project. */

import { useState } from 'react';
import { Button, Card, EmptyState, IconLock, IconNotes, IconPlus, SegmentedControl, Select, Switch, cx } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { filterNotes, noteTitle, notePreview } from '../lib/model';
import type { NoteScope } from '../lib/model';
import { formatRelative } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, SearchField, useAction, useDraftId } from '../components/common';
import { NoteEditor } from './NoteEditor';
import { cacheCreatedNote, useNotes, useProjects, useRefresh, useWorkspace } from '../app/workspace';

const ANY = '*';
const NONE = 'none';

export function NotesView({ noteId }: { noteId: string | null }) {
  const { client, workspace, user, memberName, nav } = useWorkspace();
  const refresh = useRefresh();
  const notes = useNotes();
  const projects = useProjects();
  const action = useAction();
  const draftId = useDraftId();
  const [scope, setScope] = useState<NoteScope>('all');
  const [projectId, setProjectId] = useState<string>(ANY);
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);

  const shown = filterNotes(
    notes.data ?? [],
    { scope, projectId: projectId === ANY ? null : projectId === NONE ? 'none' : projectId, search, archived },
    user.id,
  );
  const projectName = (id: string | null) => (id ? (projects.data ?? []).find((p) => p.id === id)?.name : undefined);

  async function create() {
    const note = await action.run(
      () =>
        api.createNote(
          client,
          {
            workspace_id: workspace.id,
            title: '',
            body: '',
            visibility: scope === 'shared' ? 'workspace' : 'private',
            project_id: projectId !== ANY && projectId !== NONE ? projectId : null,
          },
          user.id,
          draftId.id(),
        ),
      undefined,
      'Couldn’t create the note:',
    );
    if (!note) return;
    draftId.done();
    cacheCreatedNote(workspace.id, note);
    refresh('notes');
    nav.navigate({ name: 'notes', id: note.id });
  }

  return (
    <div className={cx('web-page', 'web-page--wide', noteId && 'web-notes--editing')}>
      <PageHeader
        title="Notes"
        subtitle="Private notes are yours alone. Shared notes are visible to, and editable by, everyone in the workspace."
        actions={
          <Button variant="primary" icon={<IconPlus size={14} />} pending={action.pending} onClick={() => void create()}>
            New note
          </Button>
        }
      />
      <div className="web-notes">
        <div className="web-notes__list">
          <div className="web-toolbar web-toolbar--stack">
            <SegmentedControl
              aria-label="Which notes"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All' },
                { value: 'mine', label: 'Private' },
                { value: 'shared', label: 'Shared' },
              ]}
            />
            <SearchField label="Search notes" value={search} onChange={setSearch} />
            <div className="web-filters">
              <Select
                aria-label="Project"
                selectSize="sm"
                className={projectId !== ANY ? 'web-filter--active' : undefined}
                value={projectId}
                onChange={setProjectId}
                options={[
                  { value: ANY, label: 'Any project' },
                  { value: NONE, label: 'No project' },
                  ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <label className="web-switch">
                <Switch checked={archived} onChange={setArchived} aria-label="Show archived notes" />
                <span>Archived</span>
              </label>
            </div>
          </div>
          {notes.problem ? <ProblemBanner problem={notes.problem} onRetry={() => void notes.reload()} /> : null}
          <Card flush>
            {notes.data === undefined ? (
              <LoadingRows rows={5} label="Loading notes" />
            ) : shown.length === 0 ? (
              <EmptyState compact icon={<IconNotes size={18} />} title={notes.data.length === 0 ? 'No notes yet' : 'No notes match'}>
                {notes.data.length === 0 ? 'Capture briefs, feedback and ideas. Share them, or keep them private.' : undefined}
              </EmptyState>
            ) : (
              <ul className="web-note-list">
                {shown.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      className="web-note-item"
                      aria-current={note.id === noteId ? 'true' : undefined}
                      onClick={() => nav.navigate({ name: 'notes', id: note.id })}
                    >
                      <span className="web-note-item__title">
                        {note.visibility === 'private' ? (
                          <>
                            <IconLock size={12} />
                            <span className="sp-visually-hidden">Private: </span>
                          </>
                        ) : null}
                        {note.pinned ? (
                          <>
                            <span className="web-pin" aria-hidden="true" />
                            <span className="sp-visually-hidden">Pinned: </span>
                          </>
                        ) : null}
                        {noteTitle(note)}
                      </span>
                      <span className="web-note-item__preview">{notePreview(note.body, 100) || 'Empty note'}</span>
                      <span className="web-note-item__meta">
                        {[
                          note.visibility === 'private' ? 'Private' : 'Shared',
                          projectName(note.project_id),
                          note.owner_id !== user.id ? memberName(note.owner_id) : null,
                          formatRelative(note.updated_at),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="web-notes__editor">
          {noteId ? (
            <NoteEditor key={noteId} noteId={noteId} onClose={() => nav.navigate({ name: 'notes', id: null })} />
          ) : (
            <Card>
              <EmptyState icon={<IconNotes size={22} />} title="Select a note">
                Or create a new one. Notes save automatically as you type.
              </EmptyState>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
