import { useEffect, useRef, useState } from 'react';
import { Badge, Banner, Button, Card, Dialog, EmptyState } from '@studio-pulse/ui';
import { formatDuration as duration } from '@studio-pulse/time-engine';
import { useNotificationFeed } from '../app/automation';
import { useWorkspace } from '../app/workspace';
import { markAllNotificationsRead, markNotificationRead, notificationData, notificationPage, NOTICE_LABELS } from '../lib/automation';
import type { Notification } from '../lib/automation';
import type { AutomationDigest } from '../../../../server/automation/digest';
import { asProblem } from '../lib/errors';
import { formatWhen } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, useAction } from '../components/common';
import { notifyProblem } from '../components/notices';

export function NotificationsView(){
  const {client,workspace,user,nav}=useWorkspace();
  const feed=useNotificationFeed();
  // The shared action covers 'Mark all read' and 'Load older'. Per-row reads have their own pending set,
  // so the implicit mark-read from 'Open task' or 'Read summary' is never dropped while another action runs.
  const action=useAction();
  const [saving,setSaving]=useState<ReadonlySet<string>>(()=>new Set());
  const savingRef=useRef(new Set<string>());
  const [older,setOlder]=useState<Notification[]>([]);
  const [more,setMore]=useState(true);
  const [selected,setSelected]=useState<Notification|null>(null);
  const lastPage=useRef<Notification[]>([]);
  useEffect(()=>{
    const page=feed.data?.items??[];
    if(feed.data&&page.length===0){setOlder([]);setSelected(null);}
    else if(page.length){
      // New notices push rows off the live first page. Once older pages are on screen, those rows move into
      // `older`, so nothing disappears between the two lists until the view remounts.
      const onPage=new Set(page.map(n=>n.id));
      const slid=lastPage.current.filter(n=>!onPage.has(n.id));
      setOlder(rows=>{
        if(rows.length===0)return rows;
        const kept=rows.filter(n=>!onPage.has(n.id));
        const known=new Set(kept.map(n=>n.id));
        return [...slid.filter(n=>!known.has(n.id)),...kept];
      });
    }
    lastPage.current=page;
  },[feed.data]);
  // Page-1 rows are the freshest copies, so they win over a stale copy in `older`.
  const pageIds=new Set((feed.data?.items??[]).map(n=>n.id));
  const items=[...(feed.data?.items??[]),...older.filter(n=>!pageIds.has(n.id))];
  async function read(item:Notification,value:boolean){
    if(savingRef.current.has(item.id))return;
    savingRef.current.add(item.id);
    setSaving(new Set(savingRef.current));
    try{
      await markNotificationRead(client,workspace.id,user.id,item.id,value);
      setOlder(rows=>rows.map(n=>n.id===item.id?{...n,read_at:value?new Date().toISOString():null}:n));
      await feed.reload();
    }catch(error){notifyProblem(asProblem(error));}
    finally{savingRef.current.delete(item.id);setSaving(new Set(savingRef.current));}
  }
  async function loadMore(){
    const last=items.at(-1);if(!last)return;
    const page=await action.run(()=>notificationPage(client,workspace.id,user.id,last));
    if(page){setOlder(rows=>{const known=new Set(rows.map(n=>n.id));return [...rows,...page.items.filter(n=>!known.has(n.id))];});setMore(page.hasMore);}
  }
  async function markAll(){
    const saved=await action.run(()=>markAllNotificationsRead(client,workspace.id,user.id),'Notifications marked as read.');
    if(saved){setOlder(rows=>rows.map(n=>({...n,read_at:n.read_at??new Date().toISOString()})));await feed.reload();}
  }
  return <div className="web-page web-automation-page">
    <PageHeader title="Notifications" subtitle={feed.data?`${feed.data.unread} unread · Private to you in this workspace`:'Loading your private notifications…'} actions={<>
      <Button size="sm" onClick={()=>nav.navigate({name:'automation'})}>Preferences</Button>
      <Button size="sm" pending={action.pending} disabled={!feed.data?.unread} onClick={()=>void markAll()}>Mark all read</Button>
      <Button size="sm" onClick={()=>void feed.reload()}>Refresh</Button>
    </>}/>
    {feed.problem?<ProblemBanner problem={feed.problem} onRetry={()=>void feed.reload()}/>:null}
    {!feed.data&&!feed.problem?<LoadingRows/>:null}
    {feed.data&&items.length===0?<Card><EmptyState title="You’re all caught up">Task updates, reminders and opted-in summaries appear here after the server delivers them.</EmptyState></Card>:null}
    <ol className="web-notifications" aria-label="Your notifications">
      {items.map(item=>{
        const data=notificationData(item);
        const digest=item.kind==='daily'||item.kind==='weekly';
        return <li key={item.id}><Card className={item.read_at?'web-notification':'web-notification web-notification--unread'}>
          <div className="web-notification__top"><Badge tone={item.read_at?'subtle':'accent'}>{NOTICE_LABELS[item.kind]}</Badge>
            <time dateTime={item.created_at}>{formatWhen(item.created_at)}</time>{!item.read_at?<span className="sp-visually-hidden">Unread</span>:null}</div>
          <h2>{item.title}</h2>
          {typeof data.projectName==='string'?<p className="web-notification__project">{data.projectName}</p>:null}
          <div className="web-notification__actions">
            {digest?<Button size="sm" onClick={()=>{setSelected(item);if(!item.read_at)void read(item,true);}}>Read summary</Button>:
              item.task_id?<Button size="sm" onClick={()=>{nav.openTask(item.task_id);if(!item.read_at)void read(item,true);}}>Open task</Button>:
              item.project_id?<Button size="sm" onClick={()=>nav.navigate({name:'project',id:item.project_id!})}>Open project</Button>:<span>Related work is no longer available.</span>}
            <Button size="sm" variant="ghost" pending={saving.has(item.id)} onClick={()=>void read(item,!item.read_at)}>{item.read_at?'Mark unread':'Mark read'}</Button>
          </div>
        </Card></li>;
      })}
    </ol>
    {(older.length===0?feed.data?.hasMore:more)?<Button pending={action.pending} onClick={()=>void loadMore()}>Load older notifications</Button>:null}
    {/* Keep the element mounted so the native close restores focus to Read summary. */}
    <Dialog open={selected !== null} onClose={() => setSelected(null)} title={selected ? NOTICE_LABELS[selected.kind] : 'Summary'} size="lg">
      {selected ? <DigestBody item={selected} onOpenTask={id => { setSelected(null); nav.openTask(id); }} /> : null}
    </Dialog>
  </div>;
}

function DigestBody({item,onOpenTask}:{item:Notification;onOpenTask:(id:string)=>void}){
  const raw=notificationData(item);
  if(raw.formatVersion!==1||!raw.time||!Array.isArray(raw.applications)||!Array.isArray(raw.projects))return <Banner tone="warning" title="Summary unavailable">This summary uses an unsupported format.</Banner>;
  const digest=raw as unknown as AutomationDigest;
  // Labels follow what the stored figures measure (formatVersion 1 field names are unchanged):
  // completedInPeriod counts tasks still done and assigned to you when the summary was generated;
  // `unassigned` is time with no project and no task, which the rest of the app calls Unattributed.
  return <>
    <p>{digest.fromDay} – {digest.toDay} · {digest.timeZone}</p>
    <p className="web-automation-hint">{digest.measurement} Task figures reflect the generation time.</p>
    <dl className="web-digest-facts">
      <div><dt>Your tasks completed in period (still done)</dt><dd>{digest.completedInPeriod}</dd></div>
      <div><dt>In progress now</dt><dd>{digest.currentTasks.counts.in_progress}</dd></div>
      <div><dt>Awaiting review now</dt><dd>{digest.currentTasks.awaitingReview}</dd></div>
      <div><dt>Overdue now</dt><dd>{digest.currentTasks.overdue}</dd></div>
      <div><dt>Active application time</dt><dd>{duration(digest.time.activeMs)}</dd></div>
      <div><dt>Foreground application time</dt><dd>{duration(digest.time.foregroundMs)}</dd></div>
      <div><dt>Unattributed active time</dt><dd>{duration(digest.unassigned.activeMs)}</dd></div>
    </dl>
    <h3>Application distribution</h3>
    <ul>{digest.applications.map(app=><li key={app.id}>{app.name} · {duration(app.activeMs)} active · {duration(app.idleMs)} idle</li>)}</ul>
    <h3>Your tasks by project</h3>
    <ul>{digest.projects.map(project=><li key={project.key}>{project.label} · {project.tasksDone}/{project.tasksTotal} of your tasks done now · {duration(project.time?.activeMs??0)} active</li>)}</ul>
    {digest.kind==='weekly'?<><h3>Daily active time</h3><ul>{digest.days.map(day=><li key={day.day}>{day.day} · {duration(day.activeMs)}</li>)}</ul></>:null}
    <h3>Upcoming and overdue work</h3>
    <ul>{digest.upcoming.map(task=><li key={task.id}><Button variant="ghost" size="sm" onClick={()=>onOpenTask(task.id)}>{task.title}</Button> · {task.dueDate}{task.overdue?' · Overdue':''}</li>)}</ul>
    <p className="web-automation-hint">Generated {formatWhen(digest.generatedAt)}. Delayed offline tracking uploads may appear in a later report.</p>
  </>;
}
