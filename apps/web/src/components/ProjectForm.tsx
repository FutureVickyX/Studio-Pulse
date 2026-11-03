/** Create or edit a project. Edits are saved only on top of the version they started from. */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, Dialog, Field, Select, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, canManageProjects, validateDates, validateName } from '../lib/model';
import type { Project, ProjectStatus } from '../lib/model';
import { DateInput, MemberSelect, useAction, useDraftId } from './common';
import { notifyProblem } from './notices';
import { cacheCreatedProject, useRefresh, useWorkspace } from '../app/workspace';

/** Only the fields that differ from `base`, so an untouched one (a former member as lead, say) is not re-sent. */
function changedFields(base: Project, fields: Required<api.ProjectPatch>): api.ProjectPatch {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => base[key as keyof api.ProjectPatch] !== value));
}

export function ProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Absent: create a new project. */
  project?: Project;
  onSaved?: (project: Project) => void;
}) {
  const { client, workspace, user, members } = useWorkspace();
  const refresh = useRefresh();
  const action = useAction();
  const draftId = useDraftId();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'active');
  const [leadId, setLeadId] = useState<string | null>(project ? project.lead_id : user.id);
  const [startDate, setStartDate] = useState<string | null>(project?.start_date ?? null);
  const [dueDate, setDueDate] = useState<string | null>(project?.due_date ?? null);
  const [touched, setTouched] = useState(false);
  // The version the fields were filled from. The `project` prop follows teammates' saves while the
  // dialog is open; saving on top of that would silently write the stale fields over theirs.
  const [base, setBase] = useState<Project | undefined>(project);
  const [conflict, setConflict] = useState<Project | null>(null);

  const nameError = touched ? validateName(name, 'The name', 120) : null;
  const descriptionError = description.length > 4000 ? 'The description can be at most 4,000 characters.' : null;
  const dateError = validateDates(startDate, dueDate);
  // Leads may edit their project, but only owners/admins hand the lead to someone else.
  const canReassignLead = canManageProjects(workspace.role);

  function adopt(current: Project) {
    setName(current.name);
    setDescription(current.description);
    setStatus(current.status);
    setLeadId(current.lead_id);
    setStartDate(current.start_date);
    setDueDate(current.due_date);
    setBase(current);
    setConflict(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (validateName(name, 'Name', 120) || descriptionError || dateError) return;
    const fields: Required<api.ProjectPatch> = {
      name: name.trim(),
      description,
      status,
      lead_id: leadId,
      start_date: startDate,
      due_date: dueDate,
    };
    if (!project) {
      const created = await action.run(
        () => api.createProject(client, { workspace_id: workspace.id, ...fields }, user.id, draftId.id()),
        'Project created.',
        'Couldn’t create the project:',
      );
      if (!created) return;
      draftId.done();
      cacheCreatedProject(workspace.id, created);
      refresh('projects');
      onSaved?.(created);
      onClose();
      return;
    }
    // After a conflict the user has seen the current version, so "Save over their changes" goes on top of it.
    const against = conflict ?? base ?? project;
    const patch = changedFields(against, fields);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const result = await action.run(() => api.updateProject(client, project.id, against.version, patch), undefined, 'Couldn’t save:');
    if (!result) return;
    if (result.status === 'conflict') {
      setConflict(result.current);
      notifyProblem({ kind: 'conflict', message: 'Someone else saved this project meanwhile. Review their version below.' });
      return;
    }
    refresh('projects');
    onSaved?.(result.row);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      size="md"
      dismissible={!action.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" pending={action.pending} onClick={(e) => void submit(e)}>
            {project ? (conflict ? 'Save over their changes' : 'Save') : 'Create project'}
          </Button>
        </>
      }
    >
      <form className="web-form" onSubmit={(e) => void submit(e)} noValidate>
        {conflict ? (
          <Banner
            tone="warning"
            title="Changed by someone else"
            action={
              <Button size="sm" onClick={() => adopt(conflict)}>
                Use their version
              </Button>
            }
          >
            Current values: “{conflict.name}”, {PROJECT_STATUS_LABEL[conflict.status]}. Saving now keeps your values instead.
          </Banner>
        ) : null}
        <Field label="Name" htmlFor="project-name" error={nameError}>
          <TextInput id="project-name" value={name} autoFocus invalid={Boolean(nameError)} onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Description" htmlFor="project-description" error={descriptionError} hint="Optional.">
          <textarea
            id="project-description"
            className="sp-input web-textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </Field>
        <div className="web-form__grid">
          <Field label="Status" htmlFor="project-status">
            <Select
              id="project-status"
              value={status}
              options={PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABEL[s] }))}
              onChange={setStatus}
            />
          </Field>
          <Field label="Lead" htmlFor="project-lead" hint={canReassignLead ? undefined : 'Owners and admins choose the lead.'}>
            <MemberSelect id="project-lead" members={members} value={leadId} onChange={setLeadId} noneLabel="No lead" disabled={!canReassignLead} />
          </Field>
          <Field label="Start date" htmlFor="project-start">
            <DateInput id="project-start" value={startDate} onChange={setStartDate} />
          </Field>
          <Field label="Due date" htmlFor="project-due" error={dateError}>
            <DateInput id="project-due" value={dueDate} onChange={setDueDate} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
