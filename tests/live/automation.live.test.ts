/** Real authenticated clients and real server scheduling. No worker/service key in this test. */
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createStudioPulseClient,validateSupabaseConfig} from '@studio-pulse/database';
import type {StudioPulseClient} from '@studio-pulse/database';
import {addDays} from '@studio-pulse/time-engine';
import * as api from '../../apps/web/src/lib/api';
import * as automation from '../../apps/web/src/lib/automation';
import type {Notification} from '../../apps/web/src/lib/automation';
import type {AutomationDigest} from '../../server/automation/digest';

interface User {label:string;id:string;email:string;password:string}
const url=process.env.SUPABASE_URL??'';
const key=process.env.SUPABASE_PUBLISHABLE_KEY??'';
const usersFile=process.env.SP_LIVE_USERS_FILE??'';
const configured=Boolean(url&&key&&usersFile);

describe.skipIf(!configured)('automation on the real development project',()=>{
 let owner:StudioPulseClient,member:StudioPulseClient,outsider:StudioPulseClient;
 let users:User[],workspace='',taskId='';
 let notices:Notification[]=[];
 const today=new Date().toISOString().slice(0,10),yesterday=addDays(today,-1);
 beforeAll(async()=>{
   const fixture=JSON.parse(readFileSync(usersFile,'utf8')) as {users:User[];automationWorkspace?:string;automationWorkspaces?:string[]};
   users=fixture.users;
   const signed:StudioPulseClient[]=[];
   for(const label of ['a','b','c']){
     const user=users.find(u=>u.label===label)!;
     const client=createStudioPulseClient(validateSupabaseConfig(url,key));
     const result=await client.auth.signInWithPassword({email:user.email,password:user.password});
     if(result.error)throw Error(`Test sign-in failed (${result.error.code??'auth'})`);
     signed.push(client);
   }
   [owner,member,outsider]=signed as [StudioPulseClient,StudioPulseClient,StudioPulseClient];
   workspace=await api.createWorkspace(owner,'SP Automation live verification');
   writeFileSync(usersFile,JSON.stringify({...fixture,automationWorkspace:workspace,
     automationWorkspaces:[...new Set([...(fixture.automationWorkspaces??[]),...(fixture.automationWorkspace?[fixture.automationWorkspace]:[]),workspace])]}),{mode:0o600});
   const invite=await api.createInvitation(owner,workspace,users.find(u=>u.label==='b')!.email,'member');
   expect(await api.acceptInvitation(member,invite.token)).toBe(workspace);
   await automation.saveWorkspaceAutomation(owner,workspace,{enabled:false,events_enabled:true,reminders_enabled:true,digests_enabled:true});
   const memberId=users.find(u=>u.label==='b')!.id;
   const entries=[
     {start:9,end:10,kind:'active' as const},
     {start:9.5,end:10.5,kind:'idle' as const},
   ].map(row=>{
     const start=Date.parse(`${yesterday}T00:00:00Z`)+row.start*3600000;
     return {id:randomUUID(),deviceId:randomUUID(),applicationId:'figma',applicationName:'Figma',
       kind:row.kind,startedAt:new Date(start).toISOString(),endedAt:new Date(Date.parse(`${yesterday}T00:00:00Z`)+row.end*3600000).toISOString(),
       activeMs:row.kind==='active'?3600000:0,idleMs:row.kind==='idle'?3600000:0,endReason:'appSwitch',revision:1};
   });
   const uploaded=await member.rpc('sync_time_entries',{p_workspace_id:workspace,p_entries:entries});
   expect(uploaded.error).toBeNull();
   expect(uploaded.data?.map(item=>item.status)).toEqual(['synced','synced']);
   await automation.saveAutomationPreferences(member,workspace,memberId,{...await automation.automationPreferences(member,workspace,memberId),
     timezone:'UTC',quietStart:0,quietEnd:0,reminderHour:0,daily:true,weekly:true,dailyHour:0,weeklyHour:0,weeklyDay:new Date(`${today}T12:00:00Z`).getUTCDay()||7});
   await automation.saveWorkspaceAutomation(owner,workspace,{enabled:true,events_enabled:true,reminders_enabled:true,digests_enabled:true});
   const created=await api.createTask(owner,{workspace_id:workspace,title:'Review the studio identity',description:'Live automation verification',
     project_id:null,status:'todo',priority:'normal',assignee_id:memberId,due_date:today},users.find(u=>u.label==='a')!.id);
   taskId=created.id;
 });
 afterAll(async()=>{
   await Promise.all([owner,member,outsider].filter(Boolean).map(client=>client.auth.signOut({scope:'local'})));
   // Workspace/user deletion is performed by the provisioning operator, using the recorded
   // exact IDs. Authenticated clients deliberately have no workspace DELETE privilege.
 });
 it('receives assignment, deadline and daily/weekly digests from the actual server schedule',async()=>{
   const userId=users.find(u=>u.label==='b')!.id;
   const deadline=Date.now()+110000;
   while(Date.now()<deadline){
     notices=(await automation.notificationFeed(member,workspace,userId)).items;
     if(['assigned','due_today','daily','weekly'].every(kind=>notices.some(n=>n.kind===kind)))break;
     await new Promise(resolve=>setTimeout(resolve,1500));
   }
   expect(notices.filter(n=>n.kind==='assigned'&&n.task_id===taskId)).toHaveLength(1);
   expect(notices.some(n=>n.kind==='due_today')).toBe(true);
   expect(notices.some(n=>n.kind==='daily')).toBe(true);
   expect(notices.some(n=>n.kind==='weekly')).toBe(true);
 },120000);
 it('keeps notifications private even from an owner, and confirms read-state changes',async()=>{
   const memberId=users.find(u=>u.label==='b')!.id;
   for(const client of [owner,outsider]){
     const result=await client.from('notifications').select('id').eq('workspace_id',workspace).eq('recipient_id',memberId);
     expect(result.error).toBeNull();expect(result.data).toEqual([]);
   }
   const notice=notices.find(n=>n.kind==='assigned')!;
   expect(await automation.markNotificationRead(member,workspace,memberId,notice.id,true)).toBe(true);
   expect((await automation.notificationFeed(member,workspace,memberId)).items.find(n=>n.id===notice.id)?.read_at).not.toBeNull();
   expect(await automation.markNotificationRead(member,workspace,memberId,notice.id,false)).toBe(true);
 });
 it('matches both digest periods to the authenticated Phase 3A reporting RPC',async()=>{
   for(const kind of ['daily','weekly'] as const){
     const notice=notices.find(n=>n.kind===kind)!;
     const digest=notice.payload as unknown as AutomationDigest;
     const report=await api.analyticsSummary(member,{workspaceId:workspace,fromDay:digest.fromDay,toDay:digest.toDay,timeZone:'UTC'});
     const total=report.find(row=>row.dimension==='total')!;
     expect(digest.time.activeMs).toBe(total.activeMs);
     expect(digest.time.idleMs).toBe(total.idleMs);
     expect(digest.time.foregroundMs).toBe(5400000);
     expect(digest.time.overlapMs).toBe(1800000);
     expect(digest.unassigned.activeMs).toBe(3600000);
   }
 });
 it('refuses forged system notices, restricted settings, and privileged jobs from normal sessions',async()=>{
   expect((await member.rpc('claim_automation_jobs',{p_limit:1})).error?.code).toBe('42501');
   expect((await member.rpc('authorize_automation_worker',{p_credential:'a'.repeat(64)})).error?.code).toBe('42501');
   expect((await member.from('notifications').insert({id:randomUUID(),workspace_id:workspace,recipient_id:users[1]!.id,kind:'assigned',title:'Forged'})).error?.code).toBe('42501');
   await expect(automation.saveWorkspaceAutomation(member,workspace,{enabled:false,events_enabled:false,reminders_enabled:false,digests_enabled:false})).rejects.toThrow();
   await expect(automation.automationOutcomes(member,workspace)).rejects.toThrow();
   const session=(await member.auth.getSession()).data.session!;
   const response=await fetch(`${url}/functions/v1/automation-worker`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`}});
   expect(response.status).toBe(401);
   const outcomes=await automation.automationOutcomes(owner,workspace);
   expect(outcomes.some(job=>job.state==='completed')).toBe(true);
   expect(outcomes.every(job=>!('payload' in job)&&!('recipient_id' in job))).toBe(true);
 });
 it('delivers a burst once while independent worker requests process the queue',async()=>{
   const memberId=users.find(u=>u.label==='b')!.id,ownerId=users.find(u=>u.label==='a')!.id;
   const tasks=await Promise.all(Array.from({length:12},(_,index)=>api.createTask(owner,{workspace_id:workspace,
     title:`Concurrent delivery ${index+1}`,description:'Disposable concurrency check',project_id:null,status:'todo',priority:'normal',assignee_id:memberId,due_date:null},ownerId)));
   const ids=tasks.map(task=>task.id);
   const fixture=JSON.parse(readFileSync(usersFile,'utf8')) as object;
   writeFileSync(usersFile,JSON.stringify({...fixture,concurrentTaskIds:ids}),{mode:0o600});
   console.log('Concurrent worker fixture ready; the operator may queue two trusted invocations.');
   const end=Date.now()+110000;
   let received:{id:string;task_id:string|null}[]=[];
   while(Date.now()<end){
     const result=await member.from('notifications').select('id,task_id').eq('workspace_id',workspace).eq('kind','assigned').in('task_id',ids);
     expect(result.error).toBeNull();received=result.data??[];
     if(received.length===12)break;
     await new Promise(resolve=>setTimeout(resolve,1500));
   }
   expect(received).toHaveLength(12);
   expect(new Set(received.map(row=>row.task_id)).size).toBe(12);
   expect(new Set(received.map(row=>row.id)).size).toBe(12);
 },120000);
});
