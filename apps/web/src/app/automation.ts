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
    const refresh=()=>invalidate(automationKey(workspace.id,user.id));
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    const channel=client.channel(`notifications:${workspace.id}:${user.id}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:`recipient_id=eq.${user.id}`},refresh)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'notifications',filter:`recipient_id=eq.${user.id}`},refresh)
      .subscribe(status=>{if(status==='SUBSCRIBED')refresh();});
    const timer=window.setInterval(visible,60_000);
    window.addEventListener('online',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{clearInterval(timer);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',visible);void client.removeChannel(channel);};
  },[client,workspace.id,user.id]);
}
