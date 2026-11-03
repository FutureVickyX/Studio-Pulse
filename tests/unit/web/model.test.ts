import { describe, expect, it } from 'vitest';

import {
  ALL_TASKS,
  canDeleteTask,
  canEditNote,
  canEditProject,
  canEditTask,
  canManageProjects,
  commitText,
  compareNotes,
  compareProjects,
  compareSubtasks,
  daysUntil,
  describeDue,
  dueState,
  filterNotes,
  filterProjects,
  filterTasks,
  groupByStatus,
  initials,
  isFormerMember,
  isOpenTask,
  isPlausibleDay,
  noteTitle,
  notePreview,
  projectInScope,
  receiveText,
  sortTasks,
  taskProgress,
  textSaved,
  validateDates,
  validateEmail,
  validateName,
  withCreatedNote,
  withCreatedProject,
  withRow,
} from '../../../apps/web/src/lib/model';
import type { Note, Project, Task, TextDraft } from '../../../apps/web/src/lib/model';

const WS = '00000000-0000-4000-8000-000000000001';
const ME = 'me';
const YOU = 'you';

let seq = 0;
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    workspace_id: WS,
    project_id: null,
    title: `Task ${seq}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    assignee_id: null,
    created_by: ME,
    due_date: null,
    start_date: null,
    estimated_minutes: null,
    completed_at: null,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: `2026-10-01T09:00:${String(seq % 60).padStart(2, '0')}Z`,
    version: 1,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: `p${seq}`,
    workspace_id: WS,
    name: `Project ${seq}`,
    description: '',
    status: 'active',
    created_by: ME,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    lead_id: null,
    start_date: null,
    due_date: null,
    version: 1,
    ...overrides,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  seq += 1;
  return {
    id: `n${seq}`,
    workspace_id: WS,
    owner_id: ME,
    project_id: null,
    title: `Note ${seq}`,
    body: '',
    visibility: 'private',
    pinned: false,
    version: 1,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: `2026-10-0${(seq % 9) + 1}T09:00:00Z`,
    archived_at: null,
    ...overrides,
  };
}

describe('due dates', () => {
  it('counts whole days across month and year ends', () => {
    expect(daysUntil('2026-11-01', '2026-10-31')).toBe(1);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
    expect(daysUntil('2026-10-24', '2026-10-24')).toBe(0);
    expect(daysUntil('2026-10-20', '2026-10-24')).toBe(-4);
    // Across a DST change (days, not 24 h periods).
    expect(daysUntil('2026-10-26', '2026-10-24')).toBe(2);
  });

  it('classifies and describes', () => {
    const today = '2026-10-24';
    expect(dueState(null, today)).toBe('none');
    expect(dueState('2026-10-23', today)).toBe('overdue');
    expect(dueState('2026-10-24', today)).toBe('today');
    expect(dueState('2026-10-31', today)).toBe('soon');
    expect(dueState('2026-11-01', today)).toBe('later');
    expect(dueState('2026-11-07', today, 14)).toBe('soon');
    expect(describeDue('2026-10-24', today)).toBe('Due today');
    expect(describeDue('2026-10-25', today)).toBe('Due tomorrow');
    expect(describeDue('2026-10-23', today)).toBe('Due yesterday');
    expect(describeDue('2026-10-20', today)).toBe('4 days overdue');
    expect(describeDue('2026-10-27', today)).toBe('Due in 3 days');
    expect(describeDue('2026-12-01', today)).toBe('Due 2026-12-01');
  });

  it('takes only whole, plausible days from a date field (not the years typing passes through)', () => {
    expect(isPlausibleDay('2027-11-05')).toBe(true);
    expect(isPlausibleDay('1900-01-01')).toBe(true);
    expect(isPlausibleDay('2028-02-29')).toBe(true);
    // Typing 2027 into the year reports 0002, 0020 and 0202 on the way.
    expect(isPlausibleDay('0002-11-05')).toBe(false);
    expect(isPlausibleDay('0202-11-05')).toBe(false);
    expect(isPlausibleDay('1899-12-31')).toBe(false);
    expect(isPlausibleDay('20271-11-05')).toBe(false);
    expect(isPlausibleDay('2027-02-30')).toBe(false);
    expect(isPlausibleDay('')).toBe(false);
  });
});

describe('task filters', () => {
  const tasks = [
    task({ title: 'Logo sketches', status: 'in_progress', assignee_id: ME, project_id: 'p-a', priority: 'high' }),
    task({ title: 'Brand guide', status: 'done', assignee_id: ME, project_id: 'p-a' }),
    task({ title: 'Old idea', status: 'archived', assignee_id: ME }),
    task({ title: 'Storyboard', status: 'todo', assignee_id: YOU, project_id: 'p-b' }),
    task({ title: 'Inbox thing', status: 'inbox' }),
  ];
  const titles = (list: Task[]) => list.map((t) => t.title).sort();

  it('open = not done and not archived; any = not archived', () => {
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, status: 'open' }))).toEqual(['Inbox thing', 'Logo sketches', 'Storyboard']);
    expect(titles(filterTasks(tasks, ALL_TASKS))).toEqual(['Brand guide', 'Inbox thing', 'Logo sketches', 'Storyboard']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, status: 'archived' }))).toEqual(['Old idea']);
  });

  it('by assignee, project, priority and title search', () => {
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, assignee: ME }))).toEqual(['Brand guide', 'Logo sketches']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, assignee: 'unassigned' }))).toEqual(['Inbox thing']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, projectId: 'p-a' }))).toEqual(['Brand guide', 'Logo sketches']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, projectId: 'none' }))).toEqual(['Inbox thing']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, priority: 'high' }))).toEqual(['Logo sketches']);
    expect(titles(filterTasks(tasks, { ...ALL_TASKS, search: '  BOARD ' }))).toEqual(['Storyboard']);
  });

  it('sorts open work by due date, then priority, then recency; finished last', () => {
    const a = task({ title: 'no due, urgent', priority: 'urgent' });
    const b = task({ title: 'due later', due_date: '2026-11-10' });
    const c = task({ title: 'due sooner, low', due_date: '2026-11-01', priority: 'low' });
    const d = task({ title: 'due sooner, high', due_date: '2026-11-01', priority: 'high' });
    const e = task({ title: 'done but due early', status: 'done', due_date: '2026-01-01' });
    expect(sortTasks([a, b, c, d, e]).map((t) => t.title)).toEqual([
      'due sooner, high',
      'due sooner, low',
      'due later',
      'no due, urgent',
      'done but due early',
    ]);
  });

  it('groups by status in workflow order, omitting empty groups', () => {
    expect(groupByStatus(tasks).map((g) => [g.status, g.tasks.length])).toEqual([
      ['inbox', 1],
      ['todo', 1],
      ['in_progress', 1],
      ['done', 1],
      ['archived', 1],
    ]);
  });

  it('progress counts done over all but archived', () => {
    expect(taskProgress(tasks)).toEqual({ done: 1, total: 4 });
    expect(taskProgress([])).toEqual({ done: 0, total: 0 });
    expect(isOpenTask({ status: 'in_review' })).toBe(true);
  });

  it('a row the server returned replaces its cached copy, or is added when new', () => {
    const a = task({ version: 1 });
    const b = task({ version: 3 });
    const savedA = { ...a, status: 'done' as const, version: 2 };
    expect(withRow([a, b], savedA)).toEqual([savedA, b]);
    const created = task();
    expect(withRow([a, b], created).map((t) => t.id)).toEqual([a.id, b.id, created.id]);
    // A refetch already brought a newer copy: the older response doesn't undo it.
    expect(withRow([a, b], { ...b, title: 'stale', version: 2 })).toEqual([a, b]);
  });
});

describe('a row just created goes into the cached list (before the refetch lands)', () => {
  it('a note goes first, the newest', () => {
    const a = note();
    const b = note();
    const created = note();
    expect(withCreatedNote([a, b], created)).toEqual([created, a, b]);
    expect(withCreatedNote([], created)).toEqual([created]);
  });

  it('a project goes where its name puts it', () => {
    const alpha = project({ name: 'alpha site' });
    const zeta = project({ name: 'Zeta rebrand' });
    const created = project({ name: 'Beta motion' });
    expect(withCreatedProject([alpha, zeta], created)?.map((p) => p.name)).toEqual(['alpha site', 'Beta motion', 'Zeta rebrand']);
    expect(withCreatedProject([], created)).toEqual([created]);
  });

  it('nothing changes while the list has not loaded: a one-row list would pass for the whole list', () => {
    expect(withCreatedNote(undefined, note())).toBeUndefined();
    expect(withCreatedProject(undefined, project())).toBeUndefined();
  });

  it('a copy a refetch already brought is kept', () => {
    const created = note({ version: 1 });
    const refetched = { ...created, title: 'Typed since', version: 2 };
    expect(withCreatedNote([note(), refetched], created)).toBeUndefined();
    const createdProject = project({ version: 1 });
    expect(withCreatedProject([{ ...createdProject, version: 2 }], createdProject)).toBeUndefined();
  });
});

describe('list orders (applied after a list is read page by page in creation order)', () => {
  it('notes: the most recently updated first, sub-second saves included; ties by id', () => {
    const whole = note({ id: 'n-b', updated_at: '2026-10-01T09:00:00+00:00' });
    const later = note({ id: 'n-c', updated_at: '2026-10-01T09:00:00.5+00:00' });
    const tie = note({ id: 'n-a', updated_at: '2026-10-01T09:00:00+00:00' });
    expect([whole, later, tie].sort(compareNotes).map((n) => n.id)).toEqual(['n-c', 'n-a', 'n-b']);
  });

  it('projects: by name; equal names by id', () => {
    const list = [project({ id: 'p-b', name: 'Same' }), project({ id: 'p-z', name: 'alpha' }), project({ id: 'p-a', name: 'Same' })];
    expect(list.sort(compareProjects).map((p) => p.id)).toEqual(['p-z', 'p-a', 'p-b']);
  });

  it('checklists: by position, then in the order the items were added', () => {
    const item = (id: string, position: number, created_at: string) => ({ id, position, created_at });
    const list = [
      item('s-c', 1, '2026-10-01T09:00:00+00:00'),
      item('s-b', 0, '2026-10-01T09:00:01+00:00'),
      item('s-a', 0, '2026-10-01T09:00:00.25+00:00'),
      item('s-0', 0, '2026-10-01T09:00:00.25+00:00'),
    ];
    expect(list.sort(compareSubtasks).map((s) => s.id)).toEqual(['s-0', 's-a', 's-b', 's-c']);
  });
});

describe('text edited in place', () => {
  const synced = (text: string): TextDraft => ({ text, base: text });

  it('a server change shows in an untouched field and leaves an edit in progress alone', () => {
    // The user's own title save lands while they are typing the description.
    const description: TextDraft = { text: 'Typed but not saved yet', base: '' };
    expect(receiveText(description, '')).toBe(description);
    expect(receiveText(synced('Old title'), 'New title')).toEqual(synced('New title'));
    // A teammate renames the task while the description is being written: the typing stays.
    expect(receiveText(description, 'Their description')).toBe(description);
    // The edit already matches what arrived: nothing left to save.
    expect(receiveText({ text: 'Same', base: 'Old' }, 'Same')).toEqual(synced('Same'));
  });

  it('leaving a field saves an edit made on top of the current server text', () => {
    expect(commitText({ text: 'New', base: 'Old' }, 'Old')).toEqual({ kind: 'save', value: 'New' });
    expect(commitText({ text: ' New ', base: 'Old' }, 'Old', 'New')).toEqual({ kind: 'save', value: 'New' });
  });

  it('nothing to save: an untouched field, or one whose text the server already has', () => {
    const untouched = synced('Same');
    expect(commitText(untouched, 'Same')).toEqual({ kind: 'unchanged', draft: untouched });
    expect(commitText(synced('Old'), 'Newer')).toEqual({ kind: 'unchanged', draft: synced('Newer') });
    expect(commitText({ text: 'Title ', base: 'Old' }, 'Title', 'Title')).toEqual({ kind: 'unchanged', draft: synced('Title') });
  });

  it('a teammate changed the same field meanwhile: their text is kept, not overwritten unseen', () => {
    const draft = receiveText({ text: 'Mine', base: 'Old' }, 'Theirs');
    expect(commitText(draft, 'Theirs')).toEqual({ kind: 'conflict', draft: synced('Theirs') });
  });

  it('after a save the saved text is the base; typing since then is kept', () => {
    expect(textSaved({ text: 'Title ', base: 'Old' }, 'Title ', 'Title')).toEqual(synced('Title'));
    expect(textSaved({ text: 'Title, more', base: 'Old' }, 'Title', 'Title')).toEqual({ text: 'Title, more', base: 'Title' });
  });
});

describe('projects', () => {
  it('scopes and search', () => {
    expect(['planning', 'active', 'on_hold'].every((s) => projectInScope(s as never, 'current'))).toBe(true);
    expect(projectInScope('completed', 'current')).toBe(false);
    expect(projectInScope('archived', 'archived')).toBe(true);
    const list = [project({ name: 'Zeta rebrand' }), project({ name: 'alpha site', status: 'completed' }), project({ name: 'Beta motion', status: 'archived' })];
    expect(filterProjects(list, 'all', '').map((p) => p.name)).toEqual(['alpha site', 'Beta motion', 'Zeta rebrand']);
    expect(filterProjects(list, 'current', '').map((p) => p.name)).toEqual(['Zeta rebrand']);
    expect(filterProjects(list, 'all', 'MOT').map((p) => p.name)).toEqual(['Beta motion']);
  });
});

describe('notes', () => {
  const mine = note({ title: 'My draft', owner_id: ME, visibility: 'private' });
  const shared = note({ title: 'Team brief', owner_id: YOU, visibility: 'workspace', project_id: 'p-a', pinned: true });
  const mySharedArchived = note({ title: 'Old shared', owner_id: ME, visibility: 'workspace', archived_at: '2026-10-02T00:00:00Z' });

  it('scopes: private = mine and private; shared = workspace notes; archived separately', () => {
    const all = [mine, shared, mySharedArchived];
    const base = { projectId: null, search: '', archived: false } as const;
    expect(filterNotes(all, { ...base, scope: 'all' }, ME).map((n) => n.title)).toEqual(['Team brief', 'My draft']);
    expect(filterNotes(all, { ...base, scope: 'mine' }, ME).map((n) => n.title)).toEqual(['My draft']);
    expect(filterNotes(all, { ...base, scope: 'shared' }, ME).map((n) => n.title)).toEqual(['Team brief']);
    expect(filterNotes(all, { ...base, scope: 'all', archived: true }, ME).map((n) => n.title)).toEqual(['Old shared']);
    expect(filterNotes(all, { ...base, scope: 'all', projectId: 'p-a' }, ME).map((n) => n.title)).toEqual(['Team brief']);
  });

  it('searches title and body; pinned first', () => {
    const body = note({ title: 'Untitled', body: 'Client wants **teal** accents', owner_id: ME });
    expect(filterNotes([mine, body], { scope: 'all', projectId: null, search: 'teal', archived: false }, ME).map((n) => n.id)).toEqual([body.id]);
  });

  it('previews strip Markdown; titles fall back to the first line', () => {
    expect(notePreview('# Heading\n\n- **bold** item `code`')).toBe('Heading bold item code');
    expect(notePreview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(noteTitle({ title: '  ', body: '\n\n## Kickoff notes\nmore' })).toBe('Kickoff notes');
    expect(noteTitle({ title: '', body: '' })).toBe('Untitled note');
  });
});

describe('permissions the UI mirrors', () => {
  it('projects: owners/admins manage; the lead edits', () => {
    expect(canManageProjects('owner')).toBe(true);
    expect(canManageProjects('admin')).toBe(true);
    expect(canManageProjects('member')).toBe(false);
    expect(canEditProject(project({ lead_id: ME }), 'member', ME)).toBe(true);
    expect(canEditProject(project({ lead_id: YOU }), 'member', ME)).toBe(false);
  });

  it('tasks: creator, assignee, owners/admins edit; creator and owners/admins delete', () => {
    const t = task({ created_by: YOU, assignee_id: ME });
    expect(canEditTask(t, 'member', ME)).toBe(true);
    expect(canDeleteTask(t, 'member', ME)).toBe(false);
    expect(canEditTask(task({ created_by: YOU }), 'member', ME)).toBe(false);
    expect(canDeleteTask(task({ created_by: YOU }), 'admin', ME)).toBe(true);
  });

  it('notes: the owner, or anyone for a shared note', () => {
    expect(canEditNote(note({ owner_id: YOU, visibility: 'private' }), ME)).toBe(false);
    expect(canEditNote(note({ owner_id: YOU, visibility: 'workspace' }), ME)).toBe(true);
  });

  it('former members: an assignee or lead not on the loaded member list', () => {
    const members = [{ userId: ME }, { userId: YOU }];
    expect(isFormerMember('gone', members)).toBe(true);
    expect(isFormerMember(YOU, members)).toBe(false);
    expect(isFormerMember(null, members)).toBe(false);
    // The list hasn't loaded yet (it always includes you): nobody is called a former member.
    expect(isFormerMember('gone', [])).toBe(false);
  });
});

describe('validation mirrors the database limits', () => {
  it('names', () => {
    expect(validateName('  ', 'The title', 200)).toBe('The title can’t be empty.');
    expect(validateName('x'.repeat(201), 'The title', 200)).toMatch(/at most 200/);
    expect(validateName(`  ${'x'.repeat(200)}  `, 'The title', 200)).toBeNull();
  });

  it('dates and emails', () => {
    expect(validateDates('2026-10-02', '2026-10-01')).toMatch(/start date/);
    expect(validateDates('2026-10-01', '2026-10-01')).toBeNull();
    expect(validateDates(null, '2026-10-01')).toBeNull();
    expect(validateEmail('ada@example.com')).toBeNull();
    expect(validateEmail('ada@')).not.toBeNull();
    expect(validateEmail(`${'a'.repeat(320)}@x.io`)).not.toBeNull();
  });

  it('initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  cher ')).toBe('C');
    expect(initials('')).toBe('?');
    expect(initials('Mary Ann Evans')).toBe('ME');
  });
});
