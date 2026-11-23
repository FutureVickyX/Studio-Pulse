import { useEffect, useState } from 'react';
import { AUTOMATION_DEFAULTS, readAutomationPreferences } from '@studio-pulse/database';
import type { AutomationPreferences } from '@studio-pulse/database';
import { Banner, Button, Card, Field, Select, Switch, TextInput } from '@studio-pulse/ui';
import { automationKey } from '../app/automation';
import { useWorkspace } from '../app/workspace';
import * as api from '../lib/automation';
import { invalidate, useQuery } from '../lib/store';
import { formatWhen } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, useAction } from '../components/common';

const personalRules=[['assignment','Task assignments'],['deadlines','Due-soon, due-today and overdue reminders'],['review','Review transitions and waiting reviews'],
  ['completion','Completion of tasks you created'],['inactive','Inactive assigned tasks'],['daily','Personal daily summary'],['weekly','Personal weekly summary']] as const;
const hours=Array.from({length:24},(_,hour)=>({value:String(hour),label:`${String(hour).padStart(2,'0')}:00`}));
const dayNames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

export function AutomationView(){
  const {client,workspace,user,nav}=useWorkspace();
  const prefix=automationKey(workspace.id,user.id);
  const preferences=useQuery(`${prefix}preferences`,()=>api.automationPreferences(client,workspace.id,user.id));
  const rules=useQuery(`${prefix}rules`,()=>api.workspaceAutomation(client,workspace.id));
  const admin=workspace.role==='owner'||workspace.role==='admin';
  const outcomes=useQuery(admin?`${prefix}outcomes`:null,()=>api.automationOutcomes(client,workspace.id));
  const [draft,setDraft]=useState<AutomationPreferences>({...AUTOMATION_DEFAULTS});
  const [dirty,setDirty]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const action=useAction();
  useEffect(()=>{if(preferences.data&&!dirty)setDraft(preferences.data);},[preferences.data,dirty]);
  function edit<K extends keyof AutomationPreferences>(key:K,value:AutomationPreferences[K]){setDraft(current=>({...current,[key]:value}));setDirty(true);setError(null);}
  async function save(){
    try{readAutomationPreferences(draft);}catch(e){setError(e instanceof Error?e.message:'Invalid preferences');return;}
    const result=await action.run(()=>api.saveAutomationPreferences(client,workspace.id,user.id,draft),'Preferences saved.');
    if(result){setDraft(result);setDirty(false);invalidate(prefix);}
  }
  return <div className="web-page web-automation-page">
    <PageHeader title="Automation settings" subtitle="Built-in rules for your own work. In-app delivery only." actions={<Button size="sm" onClick={()=>nav.navigate({name:'notifications'})}>Notifications</Button>}/>
    <Banner tone="info" title="Delivered by the server">Scheduled work runs independently of your desktop. Saving preferences does not install or verify the server scheduler. Email and Windows notification delivery are not configured here.</Banner>
    {preferences.problem?<ProblemBanner problem={preferences.problem} onRetry={()=>void preferences.reload()}/>:null}
    {!preferences.data&&!preferences.problem?<LoadingRows/>:null}
    {preferences.data?<>
      <Card title="Personal notifications" description="Only you can change these preferences. Review notices go to the existing project lead.">
        {personalRules.map(([key,label])=><div className="web-automation-setting" key={key}><label id={`automation-${key}`}>{label}</label>
          <Switch checked={draft[key]} onChange={value=>edit(key,value)} aria-labelledby={`automation-${key}`}/></div>)}
      </Card>
      <Card title="Timing" description="Deadline dates follow this time zone. Hours use a 24-hour clock.">
        <div className="web-automation-fields">
          <Field label="Preferred time zone" htmlFor="automation-zone" hint="For example Africa/Lagos, Europe/London or UTC."><TextInput id="automation-zone" value={draft.timezone} maxLength={80} onChange={e=>edit('timezone',e.currentTarget.value)}/></Field>
          <div><Button size="sm" onClick={()=>edit('timezone',Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this device’s time zone</Button></div>
          <NumberSetting label="Due-soon reminder (days before deadline)" value={draft.dueSoonDays} min={1} max={14} onChange={v=>edit('dueSoonDays',v)}/>
          <HourSetting label="Reminder delivery hour" value={draft.reminderHour} onChange={v=>edit('reminderHour',v)}/>
          <NumberSetting label="Overdue reminder interval (days)" value={draft.overdueEveryDays} min={1} max={30} onChange={v=>edit('overdueEveryDays',v)}/>
          <NumberSetting label="Review waiting threshold (days)" value={draft.reviewAfterDays} min={1} max={30} onChange={v=>edit('reviewAfterDays',v)}/>
          <NumberSetting label="Inactive task threshold (days)" value={draft.inactiveAfterDays} min={1} max={30} onChange={v=>edit('inactiveAfterDays',v)}/>
          <HourSetting label="Quiet hours start" value={draft.quietStart} onChange={v=>edit('quietStart',v)}/>
          <HourSetting label="Quiet hours end" value={draft.quietEnd} onChange={v=>edit('quietEnd',v)}/>
          <HourSetting label="Daily summary hour" value={draft.dailyHour} onChange={v=>edit('dailyHour',v)}/>
          <Field label="Weekly summary day" htmlFor="automation-weekday"><Select id="automation-weekday" value={String(draft.weeklyDay)} options={dayNames.map((name,i)=>({value:String(i+1),label:name}))} onChange={v=>edit('weeklyDay',Number(v))}/></Field>
          <HourSetting label="Weekly summary hour" value={draft.weeklyHour} onChange={v=>edit('weeklyHour',v)}/>
        </div>
        <p className="web-automation-hint">Equal quiet-hour start and end disable quiet hours. Daily summaries cover the previous complete local day; weekly summaries cover seven complete local days. Inactivity reminders repeat at most weekly. Times are approximate to the server’s planning interval.</p>
        {error?<Banner tone="danger">{error}</Banner>:null}
        <div className="web-notification__actions"><Button pending={action.pending} disabled={!dirty} onClick={()=>void save()}>Save preferences</Button><span role="status">{action.pending?'Saving…':dirty?'Unsaved changes':'Preferences loaded'}</span></div>
      </Card>
    </>:null}
    {rules.problem?<ProblemBanner problem={rules.problem} onRetry={()=>void rules.reload()}/>:null}
    {rules.data?<WorkspaceRules key={workspace.id} value={rules.data} admin={admin} save={value=>api.saveWorkspaceAutomation(client,workspace.id,value)} onSaved={()=>invalidate(prefix)}/>:null}
    {admin?<Card title="Recent automation outcomes" description="Administrator view: job metadata only, without private payloads." actions={<Button size="sm" onClick={()=>void outcomes.reload()}>Refresh</Button>}>
      {outcomes.problem?<ProblemBanner problem={outcomes.problem} onRetry={()=>void outcomes.reload()}/>:null}
      {outcomes.data?.length===0?<p>No outcomes yet. Deploy and verify the server scheduler before expecting automatic delivery.</p>:null}
      <div className="web-automation-table"><table><thead><tr><th>Type</th><th>State</th><th>Attempts</th><th>Next eligible</th><th>Outcome</th></tr></thead>
        <tbody>{outcomes.data?.map(job=><tr key={job.id}><td>{job.kind}</td><td>{job.state}</td><td>{job.attempts}/5</td><td>{job.state==='retry'||job.state==='pending'?formatWhen(job.run_after):'—'}</td><td>{job.last_error??(job.completed_at?formatWhen(job.completed_at):'—')}</td></tr>)}</tbody></table></div>
    </Card>:null}
  </div>;
}

function HourSetting({label,value,onChange}:{label:string;value:number;onChange:(value:number)=>void}){
  return <Field label={label}><Select aria-label={label} value={String(value)} options={hours} onChange={v=>onChange(Number(v))}/></Field>;
}
function NumberSetting({label,value,min,max,onChange}:{label:string;value:number;min:number;max:number;onChange:(value:number)=>void}){
  return <Field label={label}><TextInput aria-label={label} type="number" min={min} max={max} value={Number.isNaN(value)?'':value} onChange={e=>onChange(e.currentTarget.valueAsNumber)}/></Field>;
}
function WorkspaceRules({value,admin,save,onSaved}:{value:api.WorkspaceAutomation;admin:boolean;save:(value:api.WorkspaceAutomation)=>Promise<unknown>;onSaved:()=>void}){
  const [draft,setDraft]=useState(value);
  const [dirty,setDirty]=useState(false);
  const action=useAction();
  useEffect(()=>{if(!dirty)setDraft(value);},[value,dirty]);
  const labels={enabled:'Enable workspace automations',events_enabled:'Task events',reminders_enabled:'Task reminders',digests_enabled:'Personal summaries'};
  async function submit(){const result=await action.run(async()=>{await save(draft);return true;},'Workspace rules saved.');if(result){setDirty(false);onSaved();}}
  return <Card title="Workspace rules" description={admin?'These switches affect every member. Individual preferences still apply.':'Managed by workspace owners and admins.'}>
    {(Object.keys(labels) as (keyof api.WorkspaceAutomation)[]).map(key=><div className="web-automation-setting" key={key}><label id={`workspace-${key}`}>{labels[key]}</label><Switch aria-labelledby={`workspace-${key}`} disabled={!admin} checked={draft[key]} onChange={v=>{setDraft(current=>({...current,[key]:v}));setDirty(true);}}/></div>)}
    {admin?<Button pending={action.pending} disabled={!dirty} onClick={()=>void submit()}>Save workspace rules</Button>:null}
  </Card>;
}
