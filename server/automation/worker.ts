import { createClient } from '@supabase/supabase-js';
import type { Database, Json, StudioPulseClient } from '@studio-pulse/database';
import { addDays, startOfLocalDay } from '@studio-pulse/time-engine';
import type { ReportInterval } from '@studio-pulse/time-engine';
import { buildDigest } from './digest';

interface Job {
  id: string; claim_token: string; kind: string; workspace_id: string; recipient_id: string;
  payload: { timezone: string; localDate: string };
}
interface Config { url: string | undefined; serviceKey: string | undefined }
const MAX_ROWS = 100_000;
/** PostgREST's default max-rows: a shorter page is the last one. */
const PAGE_ROWS = 1000;
function checked<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) throw new Error('database_request_failed');
  return result.data;
}
/**
 * Keyset pages by id. Offset paging could skip a surviving row when the recipient deletes rows
 * between two pages, silently under-reporting the summary.
 */
async function listByKey<T extends { id: string }>(page: (after: string | null, limit: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let after: string | null = null; ;) {
    const batch: T[] = checked(await page(after, PAGE_ROWS));
    rows.push(...batch);
    if (rows.length > MAX_ROWS) throw new Error('report_limit_exceeded');
    const last: T | undefined = batch.at(-1);
    if (!last || batch.length < PAGE_ROWS) return rows;
    after = last.id;
  }
}

async function summary(client: StudioPulseClient, job: Job) {
  const membership = await client.from('workspace_members').select('status').eq('workspace_id',job.workspace_id).eq('user_id',job.recipient_id).maybeSingle();
  if (membership.error) throw new Error('database_request_failed');
  if (!membership.data || membership.data.status !== 'active') return null;
  const kind = job.kind === 'daily' ? 'daily' : 'weekly';
  const from = startOfLocalDay(addDays(job.payload.localDate,kind==='daily'?-1:-7),job.payload.timezone);
  const to = startOfLocalDay(job.payload.localDate,job.payload.timezone);
  // The server's privilege is confined to the claimed recipient and workspace on every read.
  const entries = await listByKey((after,limit)=>{
    let query=client.from('time_entries').select('*')
      .eq('workspace_id',job.workspace_id).eq('user_id',job.recipient_id)
      .gte('started_at',new Date(from-744*3_600_000).toISOString()).lt('started_at',new Date(to).toISOString())
      .gt('ended_at',new Date(from).toISOString());
    if(after!==null)query=query.gt('id',after);
    return query.order('id').limit(limit);
  });
  const tasks = await listByKey((after,limit)=>{
    let query=client.from('tasks').select('*').eq('workspace_id',job.workspace_id).eq('assignee_id',job.recipient_id);
    if(after!==null)query=query.gt('id',after);
    return query.order('id').limit(limit);
  });
  const projects = await listByKey((after,limit)=>{
    let query=client.from('projects').select('*').eq('workspace_id',job.workspace_id);
    if(after!==null)query=query.gt('id',after);
    return query.order('id').limit(limit);
  });
  const intervals: ReportInterval[] = entries.map(row=>({ id:row.id, userId:row.user_id,deviceId:row.device_id,
    applicationId:row.application_id,applicationName:row.application_name,kind:row.kind,
    startMs:Date.parse(row.started_at),endMs:Date.parse(row.ended_at),projectId:row.project_id,taskId:row.task_id }));
  return buildDigest({kind,userId:job.recipient_id,workspaceId:job.workspace_id,timeZone:job.payload.timezone,
    localDate:job.payload.localDate,now:Date.now(),intervals,tasks,projects});
}

/** Server-only endpoint. User JWTs and publishable keys cannot trigger privileged job work. */
export function createAutomationWorker(config: Config, makeClient: (url: string,key: string)=>StudioPulseClient = (url,key)=>createClient<Database>(url,key,{auth:{persistSession:false,autoRefreshToken:false}})) {
  let client: StudioPulseClient | undefined;
  return async (request: Request): Promise<Response> => {
    const respond=(status:number,body:object)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
    if(request.method!=='POST')return respond(405,{error:'method_not_allowed'});
    if(!config.url||!config.serviceKey)return respond(503,{error:'worker_not_configured'});
    const credential=request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if(!credential)return respond(401,{error:'unauthorized'});
    try {
      client??=makeClient(config.url,config.serviceKey);
      // The service credential never arrives in a scheduled HTTP request. Only this bounded
      // invocation key is sent; its hash is checked by a service-only RPC before any job runs.
      if(!checked(await client.rpc('authorize_automation_worker',{p_credential:credential})))return respond(401,{error:'unauthorized'});
      // A planning failure must not stop delivery of jobs already queued for every other workspace.
      // It is reported in the status and the run line, so pg_net's response log shows it.
      let planningFailed=false;
      try{checked(await client.rpc('plan_automation_jobs',{p_limit:100}));}catch{planningFailed=true;}
      const raw=checked(await client.rpc('claim_automation_jobs',{p_limit:10}));
      if(!Array.isArray(raw))throw new Error('invalid_job_batch');
      const counts={completed:0,skipped:0,deferred:0,failed:0};
      for(const value of raw){
        const job=value as unknown as Job;
        try{
          const report=job.kind==='daily'||job.kind==='weekly'?await summary(client,job):null;
          const result=checked(await client.rpc('finish_automation_job',{p_id:job.id,p_token:job.claim_token,
            p_summary:report===null?null:JSON.parse(JSON.stringify(report)) as Json}));
          if(result==='completed'||result==='skipped'||result==='deferred')counts[result]++;
          else throw new Error('invalid_delivery_result');
        }catch{
          // Never persist an exception message, credential, note, task body or raw time entry.
          const failed=await client.rpc('fail_automation_job',{p_id:job.id,p_token:job.claim_token,p_code:job.kind==='daily'||job.kind==='weekly'?'reporting_failed':'delivery_failed'});
          // 40001: the claim is no longer this run's. If the delivery committed and only its response
          // was lost, finish returns the terminal state without a claim check; count what happened.
          const settled=(failed.error as {code?:string}|null)?.code==='40001'
            ?await client.rpc('finish_automation_job',{p_id:job.id,p_token:job.claim_token,p_summary:null}):null;
          if(settled&&!settled.error&&(settled.data==='completed'||settled.data==='skipped'))counts[settled.data]++;
          else counts.failed++;
        }
      }
      // One line per run with counts only: no ids, tokens, payloads or recipients.
      console.log(JSON.stringify({event:'automation_run',planning:planningFailed?'failed':'ok',...counts}));
      // Per-job failures stay database-managed retries (200); only a planning failure changes the status.
      return planningFailed?respond(503,{error:'planning_failed',...counts}):respond(200,counts);
    }catch{
      return respond(503,{error:'automation_temporarily_unavailable'});
    }
  };
}
