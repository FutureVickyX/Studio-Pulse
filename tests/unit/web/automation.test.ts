import { describe, expect, it, vi } from 'vitest';
import { AUTOMATION_DEFAULTS, readAutomationPreferences } from '@studio-pulse/database';
import type { StudioPulseClient } from '@studio-pulse/database';
import { summarizeReport } from '@studio-pulse/time-engine';
import type { ReportInterval } from '@studio-pulse/time-engine';
import type { Task } from '../../../apps/web/src/lib/model';
import { buildDigest } from '../../../server/automation/digest';
import { createAutomationWorker } from '../../../server/automation/worker';

const interval=(id:string,kind:'active'|'idle',start:string,end:string,userId='me'):ReportInterval=>({
  id,userId,deviceId:id,applicationId:'figma',applicationName:'Figma',kind,startMs:Date.parse(start),endMs:Date.parse(end),projectId:null,taskId:null,
});
const task=(id:string,status:Task['status'],extra:Partial<Task>={}):Task=>({
  id,workspace_id:'ws',project_id:null,title:id,description:'',status,priority:'normal',assignee_id:'me',created_by:'me',due_date:null,
  start_date:null,estimated_minutes:null,completed_at:null,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',version:1,...extra,
});

describe('automation preferences',()=>{
  it('shares sensible defaults and validates timing, booleans and IANA zones',()=>{
    expect(readAutomationPreferences({})).toEqual(AUTOMATION_DEFAULTS);
    expect(readAutomationPreferences({timezone:'Africa/Lagos',weeklyDay:7,quietStart:22})).toMatchObject({timezone:'Africa/Lagos',weeklyDay:7});
    for(const value of [{daily:'true'},{quietStart:24},{weeklyDay:0},{reminderHour:1.5},{timezone:'CET'},{timezone:'invalid/place'},{unknown:true},JSON.parse('{"__proto__":{"daily":true}}')]){
      expect(()=>readAutomationPreferences(value)).toThrow();
    }
  });
});

describe('daily and weekly summaries reuse Phase 3A',()=>{
  const intervals=[
    interval('a','active','2026-11-14T09:00:00Z','2026-11-14T10:00:00Z'),
    interval('b','idle','2026-11-14T09:30:00Z','2026-11-14T10:30:00Z'),
    interval('c','active','2026-11-14T09:00:00Z','2026-11-14T15:00:00Z','someone-else'),
  ];
  it('matches the analytics engine, excludes other users, and labels measurements',()=>{
    const result=buildDigest({kind:'daily',workspaceId:'ws',userId:'me',timeZone:'UTC',localDate:'2026-11-15',now:Date.parse('2026-11-15T17:00:00Z'),intervals,
      tasks:[task('done','done',{completed_at:'2026-11-14T16:00:00Z'}),task('review','in_review'),task('theirs','done',{assignee_id:'someone-else'})],projects:[]});
    const expected=summarizeReport(intervals,{fromDay:'2026-11-14',toDay:'2026-11-14',timeZone:'UTC',userIds:['me']}).find(r=>r.dimension==='total')!;
    expect(result.time.activeMs).toBe(expected.activeMs);
    expect(result.time.idleMs).toBe(expected.idleMs);
    expect(result.time.foregroundMs).toBe(5_400_000);
    expect(result.time.overlapMs).toBe(1_800_000);
    expect(result.unassigned.activeMs).toBe(result.time.activeMs);
    expect(result.completedInPeriod).toBe(1);
    expect(result.currentTasks.awaitingReview).toBe(1);
    expect(result.currentTasks.total).toBe(2);
    expect(result.measurement).toContain('not manual or billable');
  });
  it('uses a complete seven-day local calendar window and consistent daily trends',()=>{
    const result=buildDigest({kind:'weekly',workspaceId:'ws',userId:'me',timeZone:'America/New_York',localDate:'2026-11-15',now:Date.parse('2026-11-15T17:00:00Z'),intervals,tasks:[],projects:[]});
    expect(result.fromDay).toBe('2026-11-08');
    expect(result.toDay).toBe('2026-11-14');
    expect(result.days.reduce((sum,day)=>sum+day.activeMs,0)).toBe(result.time.activeMs);
  });
});

describe('trusted automation HTTP worker',()=>{
  const credential='a'.repeat(64);
  it('rejects ordinary user credentials before creating a privileged client',async()=>{
    const factory=vi.fn();
    const handler=createAutomationWorker({url:'https://example.invalid',serviceKey:'test-service-credential'},factory);
    expect((await handler(new Request('https://example.invalid',{method:'POST',headers:{Authorization:'Bearer ordinary-user'}}))).status).toBe(401);
    expect((await handler(new Request('https://example.invalid',{method:'GET'}))).status).toBe(405);
    expect(factory).not.toHaveBeenCalled();
  });
  it('reports missing configuration without exposing values',async()=>{
    const handler=createAutomationWorker({url:undefined,serviceKey:undefined});
    const response=await handler(new Request('https://example.invalid',{method:'POST'}));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'worker_not_configured'});
  });
  it('plans, claims and confirms delivery; failures remain database-managed retries',async()=>{
    const job={id:'job',claim_token:'token',kind:'assigned',workspace_id:'ws',recipient_id:'me',payload:{}};
    const rpc=vi.fn().mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:1,error:null}).mockResolvedValueOnce({data:[job],error:null})
      .mockResolvedValueOnce({data:'completed',error:null});
    const handler=createAutomationWorker({url:'https://example.invalid',serviceKey:'test-service-credential'},()=>({rpc}) as unknown as StudioPulseClient);
    const response=await handler(new Request('https://example.invalid',{method:'POST',headers:{Authorization:`Bearer ${credential}`}}));
    expect(await response.json()).toEqual({completed:1,skipped:0,deferred:0,failed:0});
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['authorize_automation_worker','plan_automation_jobs','claim_automation_jobs','finish_automation_job']);
    expect(rpc.mock.calls[3]?.[1]).toEqual({p_id:'job',p_token:'token',p_summary:null});
  });
  it('never logs or returns underlying failure messages',async()=>{
    const rpc=vi.fn().mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:1,error:null}).mockResolvedValueOnce({data:[{id:'j',claim_token:'t',kind:'assigned'}],error:null})
      .mockResolvedValueOnce({data:null,error:{message:'private information'}}).mockResolvedValueOnce({data:null,error:null});
    const handler=createAutomationWorker({url:'https://example.invalid',serviceKey:'test-service-credential'},()=>({rpc}) as unknown as StudioPulseClient);
    const response=await handler(new Request('https://example.invalid',{method:'POST',headers:{Authorization:`Bearer ${credential}`}}));
    expect(await response.json()).toEqual({completed:0,skipped:0,deferred:0,failed:1});
    expect(rpc.mock.calls[4]?.[1]).toEqual({p_id:'j',p_token:'t',p_code:'delivery_failed'});
  });
  it('rejects a well-formed but unregistered scheduler key before planning any jobs',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:false,error:null});
    const handler=createAutomationWorker({url:'https://example.invalid',serviceKey:'test-service-credential'},()=>({rpc}) as unknown as StudioPulseClient);
    const result=await handler(new Request('https://example.invalid',{method:'POST',headers:{Authorization:`Bearer ${credential}`}}));
    expect(result.status).toBe(401);
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['authorize_automation_worker']);
  });
});
