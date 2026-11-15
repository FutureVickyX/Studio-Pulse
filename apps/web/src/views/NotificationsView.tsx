import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, EmptyState } from '@studio-pulse/ui';
import { formatDuration as duration } from '@studio-pulse/time-engine';
import { useNotificationFeed } from '../app/automation';
import { useWorkspace } from '../app/workspace';
import { markAllNotificationsRead, markNotificationRead, notificationData, notificationPage, NOTICE_LABELS } from '../lib/automation';
import type { Notification } from '../lib/automation';
import type { AutomationDigest } from '../../../../server/automation/digest';
import { formatWhen } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, useAction } from '../components/common';

export function NotificationsView(){
  const {client,workspace,user,nav}=useWorkspace();
  const feed=useNotificationFeed();
  const action=useAction();
  const [older,setOlder]=useState<Notification[]>([]);
  const [more,setMore]=useState(true);
  const [selected,setSelected]=useState<Notification|null>(null);
  useEffect(()=>{if(feed.data?.items.length===0){setOlder([]);setSelected(null);}},[feed.data]);
  const items=[...new Map([...(feed.data?.items??[]),...older].map(n=>[n.id,n])).values()];
  async function read(item:Notification,value:boolean){
    const saved=await action.run(()=>markNotificationRead(client,workspace.id,user.id,item.id,value));
    if(saved){setOlder(rows=>rows.map(n=>n.id===item.id?{...n,read_at:value?new Date().toISOString():null}:n));await feed.reload();}
  }
  async function loadMore(){
    const last=items.at(-1);if(!last)return;
    const page=await action.run(()=>notificationPage(client,workspace.id,user.id,last));
    if(page){setOlder(rows=>[...rows,...page.items]);setMore(page.hasMore);}
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
            <Button size="sm" variant="ghost" pending={action.pending} onClick={()=>void read(item,!item.read_at)}>{item.read_at?'Mark unread':'Mark read'}</Button>
          </div>
        </Card></li>;
      })}
    </ol>
    {(older.length===0?feed.data?.hasMore:more)?<Button pending={action.pending} onClick={()=>void loadMore()}>Load older notifications</Button>:null}
    {selected?<DigestCard item={selected} onClose={()=>setSelected(null)}/>:null}
  </div>;
}

function DigestCard({item,onClose}:{item:Notification;onClose:()=>void}){
  const {nav}=useWorkspace();
  const raw=notificationData(item);
  if(raw.formatVersion!==1||!raw.time||!Array.isArray(raw.applications)||!Array.isArray(raw.projects))return <Banner tone="warning" title="Summary unavailable">This summary uses an unsupported format.</Banner>;
  const digest=raw as unknown as AutomationDigest;
  return <Card title={NOTICE_LABELS[item.kind]} actions={<Button size="sm" onClick={onClose}>Close summary</Button>}>
    <p>{digest.fromDay} – {digest.toDay} · {digest.timeZone}</p>
    <p className="web-automation-hint">{digest.measurement} Task progress reflects the generation time.</p>
    <dl className="web-digest-facts">
      <div><dt>Completed in period</dt><dd>{digest.completedInPeriod}</dd></div>
      <div><dt>In progress now</dt><dd>{digest.currentTasks.counts.in_progress}</dd></div>
      <div><dt>Awaiting review now</dt><dd>{digest.currentTasks.awaitingReview}</dd></div>
      <div><dt>Overdue now</dt><dd>{digest.currentTasks.overdue}</dd></div>
      <div><dt>Active application time</dt><dd>{duration(digest.time.activeMs)}</dd></div>
      <div><dt>Foreground application time</dt><dd>{duration(digest.time.foregroundMs)}</dd></div>
      <div><dt>Unassigned active time</dt><dd>{duration(digest.unassigned.activeMs)}</dd></div>
    </dl>
    <h3>Application distribution</h3>
    <ul>{digest.applications.map(app=><li key={app.id}>{app.name} · {duration(app.activeMs)} active · {duration(app.idleMs)} idle</li>)}</ul>
    <h3>Project progress</h3>
    <ul>{digest.projects.map(project=><li key={project.key}>{project.label} · {project.tasksDone}/{project.tasksTotal} tasks done · {duration(project.time?.activeMs??0)} active</li>)}</ul>
    {digest.kind==='weekly'?<><h3>Daily active time</h3><ul>{digest.days.map(day=><li key={day.day}>{day.day} · {duration(day.activeMs)}</li>)}</ul></>:null}
    <h3>Upcoming and overdue work</h3>
    <ul>{digest.upcoming.map(task=><li key={task.id}><Button variant="ghost" size="sm" onClick={()=>nav.openTask(task.id)}>{task.title}</Button> · {task.dueDate}{task.overdue?' · Overdue':''}</li>)}</ul>
    <p className="web-automation-hint">Generated {formatWhen(digest.generatedAt)}. Delayed offline tracking uploads may appear in a later report.</p>
  </Card>;
}
