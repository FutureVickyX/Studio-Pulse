import { readAutomationPreferences } from '@studio-pulse/database';
import type { AutomationPreferences, Json, StudioPulseClient, Tables } from '@studio-pulse/database';
import { ProblemError, toProblem } from './errors';

export type Notification = Tables<'notifications'>;
export type WorkspaceAutomation = Pick<Tables<'workspace_automation_settings'>,'enabled'|'events_enabled'|'reminders_enabled'|'digests_enabled'>;
export const WORKSPACE_AUTOMATION_DEFAULTS: WorkspaceAutomation = {enabled:true,events_enabled:true,reminders_enabled:true,digests_enabled:true};
export const NOTICE_LABELS: Record<Notification['kind'],string> = {
  assigned:'Task assigned',review:'Ready for review',completed:'Task completed',due_soon:'Due soon',due_today:'Due today',
  overdue:'Overdue task',awaiting_review:'Awaiting review',inactive:'Needs attention',daily:'Daily summary',weekly:'Weekly summary',
};
function fail(error: unknown): never {
  const code=(error as {code?:string}|null)?.code;
  if(code==='PGRST205'||code==='42P01'||code==='PGRST202')throw new ProblemError({kind:'blocked',message:'Notifications need the latest database migrations. Ask the workspace administrator to deploy Phase 3B.'});
  throw new ProblemError(toProblem(error));
}

export async function notificationPage(client: StudioPulseClient, workspace: string, user: string, before?: Pick<Notification,'created_at'|'id'>) {
  let query=client.from('notifications').select('*').eq('workspace_id',workspace).eq('recipient_id',user)
    .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(51);
  if(before){
    const date=new Date(before.created_at).toISOString();
    if(!/^[0-9a-f-]{36}$/i.test(before.id))throw new Error('Invalid notification cursor');
    query=query.or(`created_at.lt."${date}",and(created_at.eq."${date}",id.lt.${before.id})`);
  }
  const {data,error}=await query;
  if(error)fail(error);
  return {items:(data??[]).slice(0,50),hasMore:(data?.length??0)>50};
}
export async function notificationFeed(client: StudioPulseClient, workspace: string, user: string) {
  const [page,count]=await Promise.all([
    notificationPage(client,workspace,user),
    client.from('notifications').select('id',{count:'exact',head:true}).eq('workspace_id',workspace).eq('recipient_id',user).is('read_at',null),
  ]);
  if(count.error)fail(count.error);
  return {...page,unread:count.count??0};
}
export async function markNotificationRead(client: StudioPulseClient,workspace:string,user:string,id:string,read:boolean) {
  const result=await client.from('notifications').update({read_at:read?new Date().toISOString():null})
    .eq('workspace_id',workspace).eq('recipient_id',user).eq('id',id).select('id').maybeSingle();
  if(result.error)fail(result.error);
  if(!result.data)fail({code:'42501'});
  return true;
}
export async function markAllNotificationsRead(client:StudioPulseClient,workspace:string,user:string) {
  const result=await client.from('notifications').update({read_at:new Date().toISOString()})
    .eq('workspace_id',workspace).eq('recipient_id',user).is('read_at',null);
  if(result.error)fail(result.error);
  return true;
}
export async function automationPreferences(client:StudioPulseClient,workspace:string,user:string) {
  const result=await client.from('notification_preferences').select('config').eq('workspace_id',workspace).eq('user_id',user).maybeSingle();
  if(result.error)fail(result.error);
  return readAutomationPreferences(result.data?.config??{});
}
export async function saveAutomationPreferences(client:StudioPulseClient,workspace:string,user:string,config:AutomationPreferences) {
  const validated=readAutomationPreferences(config);
  const update=()=>client.from('notification_preferences').update({config:validated}).eq('workspace_id',workspace).eq('user_id',user).select('config').maybeSingle();
  let result=await update();
  if(result.error)fail(result.error);
  if(!result.data){
    result=await client.from('notification_preferences').insert({workspace_id:workspace,user_id:user,config:validated}).select('config').single();
    if(result.error?.code==='23505')result=await update();
    if(result.error)fail(result.error);
  }
  if(!result.data)fail({code:'42501'});
  return readAutomationPreferences(result.data.config);
}
export async function workspaceAutomation(client:StudioPulseClient,workspace:string):Promise<WorkspaceAutomation> {
  const result=await client.from('workspace_automation_settings').select('*').eq('workspace_id',workspace).maybeSingle();
  if(result.error)fail(result.error);
  return result.data??WORKSPACE_AUTOMATION_DEFAULTS;
}
export async function saveWorkspaceAutomation(client:StudioPulseClient,workspace:string,value:WorkspaceAutomation) {
  const update=()=>client.from('workspace_automation_settings').update(value).eq('workspace_id',workspace).select('*').maybeSingle();
  let result=await update();
  if(result.error)fail(result.error);
  if(!result.data){
    result=await client.from('workspace_automation_settings').insert({...value,workspace_id:workspace}).select('*').single();
    if(result.error?.code==='23505')result=await update();
    if(result.error)fail(result.error);
  }
  if(!result.data)fail({code:'42501'});
  return result.data;
}
export interface AutomationOutcome {id:string;kind:string;state:string;attempts:number;created_at:string;run_after:string;completed_at:string|null;failed_at:string|null;last_error:string|null}
export async function automationOutcomes(client:StudioPulseClient,workspace:string):Promise<AutomationOutcome[]> {
  const result=await client.rpc('automation_outcomes',{p_workspace_id:workspace});
  if(result.error)fail(result.error);
  return Array.isArray(result.data)?result.data as unknown as AutomationOutcome[]:[];
}
export function notificationData(notification:Notification):Record<string,Json|undefined> {
  return notification.payload&&typeof notification.payload==='object'&&!Array.isArray(notification.payload)?notification.payload:{};
}
