import { createClient } from '@supabase/supabase-js';
import type { Database, Json, StudioPulseClient } from '@studio-pulse/database';
import { addDays, startOfLocalDay } from '@studio-pulse/time-engine';
import type { ReportInterval } from '@studio-pulse/time-engine';
import { listAll } from '../../apps/web/src/lib/api';
import { buildDigest } from './digest';

interface Job {
  id: string; claim_token: string; kind: string; workspace_id: string; recipient_id: string;
  payload: { timezone: string; localDate: string };
}
interface Config { url: string | undefined; serviceKey: string | undefined }
const MAX_ROWS = 100_000;
function checked<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) throw new Error('database_request_failed');
  return result.data;
}
function bounded<T>(rows: T[]): T[] {
  if (rows.length > MAX_ROWS) throw new Error('report_limit_exceeded');
  return rows;
}

async function summary(client: StudioPulseClient, job: Job) {
  const membership = await client.from('workspace_members').select('status').eq('workspace_id',job.workspace_id).eq('user_id',job.recipient_id).maybeSingle();
  if (membership.error) throw new Error('database_request_failed');
  if (!membership.data || membership.data.status !== 'active') return null;
  const kind = job.kind === 'daily' ? 'daily' : 'weekly';
  const from = startOfLocalDay(addDays(job.payload.localDate,kind==='daily'?-1:-7),job.payload.timezone);
  const to = startOfLocalDay(job.payload.localDate,job.payload.timezone);
  // The server's privilege is confined to the claimed recipient and workspace on every read.
  const entries = bounded(await listAll((a,b)=>client.from('time_entries').select('*')
    .eq('workspace_id',job.workspace_id).eq('user_id',job.recipient_id)
    .gte('started_at',new Date(from-744*3_600_000).toISOString()).lt('started_at',new Date(to).toISOString())
    .gt('ended_at',new Date(from).toISOString()).order('id').range(a,b),MAX_ROWS+1));
  const tasks = bounded(await listAll((a,b)=>client.from('tasks').select('*').eq('workspace_id',job.workspace_id)
    .eq('assignee_id',job.recipient_id).order('id').range(a,b),MAX_ROWS+1));
  const projects = bounded(await listAll((a,b)=>client.from('projects').select('*').eq('workspace_id',job.workspace_id).order('id').range(a,b),MAX_ROWS+1));
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
      checked(await client.rpc('plan_automation_jobs',{p_limit:100}));
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
          counts.failed++;
          // Never persist an exception message, credential, note, task body or raw time entry.
          await client.rpc('fail_automation_job',{p_id:job.id,p_token:job.claim_token,p_code:job.kind==='daily'||job.kind==='weekly'?'reporting_failed':'delivery_failed'});
        }
      }
      return respond(200,counts);
    }catch{
      return respond(503,{error:'automation_temporarily_unavailable'});
    }
  };
}
