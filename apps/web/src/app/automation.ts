import { useEffect } from 'react';
import { invalidate, useQuery } from '../lib/store';
import { notificationFeed } from '../lib/automation';
import { useWorkspace } from './workspace';

export const automationKey=(workspace:string,user:string)=>`ws:${workspace}:automation:${user}:`;
export function useNotificationFeed(){
  const {client,workspace,user}=useWorkspace();
  return useQuery(`${automationKey(workspace.id,user.id)}feed`,()=>notificationFeed(client,workspace.id,user.id));
}
/** This only refreshes already-delivered notices; scheduled jobs never run in the browser. */
export function useAutomationRefresh(){
  const {client,workspace,user}=useWorkspace();
  useEffect(()=>{
    // Realtime sends one event per changed row ('Mark all read' on 300 notices is 300 UPDATEs, each
    // echoed back), so refreshes are coalesced: at most one feed load per window, and an event that
    // arrives after the load starts schedules the next one.
    let pending:number|undefined;
    const refresh=()=>{
      if(pending!==undefined)return;
      pending=window.setTimeout(()=>{pending=undefined;invalidate(automationKey(workspace.id,user.id));},250);
    };
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    const channel=client.channel(`notifications:${workspace.id}:${user.id}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:`recipient_id=eq.${user.id}`},refresh)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'notifications',filter:`recipient_id=eq.${user.id}`},refresh)
      .subscribe(status=>{if(status==='SUBSCRIBED')refresh();});
    const timer=window.setInterval(visible,60_000);
    window.addEventListener('online',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{if(pending!==undefined)clearTimeout(pending);clearInterval(timer);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',visible);void client.removeChannel(channel);};
  },[client,workspace.id,user.id]);
}
