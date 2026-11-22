/// <reference types="vite/client" />
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AUTOMATION_DEFAULTS} from '@studio-pulse/database';
import {NotificationsView} from '../../../apps/web/src/views/NotificationsView';
import {AutomationView} from '../../../apps/web/src/views/AutomationView';
import type {Notification} from '../../../apps/web/src/lib/automation';
import type {Problem} from '../../../apps/web/src/lib/errors';
import {formatDay} from '../../../apps/web/src/lib/format';

const state=vi.hoisted(()=>({role:'member',items:[] as Notification[],problem:null as Problem|null,loading:false,outcomes:[] as unknown[]}));
vi.mock('../../../apps/web/src/app/workspace',async original=>({...await original<object>(),useWorkspace:()=>({
  client:{},workspace:{id:'workspace',role:state.role},user:{id:'user'},nav:{navigate:vi.fn(),openTask:vi.fn()},
})}));
vi.mock('../../../apps/web/src/app/automation',()=>({
  automationKey:()=> 'automation:',
  useNotificationFeed:()=>({data:state.loading?undefined:{items:state.items,hasMore:false,unread:state.items.filter(n=>!n.read_at).length},problem:state.problem,reload:vi.fn()}),
}));
vi.mock('../../../apps/web/src/lib/store',async original=>({...await original<object>(),useQuery:(key:string|null)=>({
  data:key?.endsWith('preferences')?AUTOMATION_DEFAULTS:key?.endsWith('rules')?{enabled:true,events_enabled:true,reminders_enabled:true,digests_enabled:true}:state.outcomes,problem:null,reload:vi.fn(),
})}));

describe('notification and automation screens',()=>{
  beforeEach(()=>{state.role='member';state.items=[];state.problem=null;state.loading=false;state.outcomes=[];});
  it('shows an honest empty state without inventing notifications',()=>{
    const html=renderToStaticMarkup(createElement(NotificationsView));
    expect(html).toContain('You’re all caught up');
    expect(html).toContain('0 unread');
    expect(html).toContain('Private to you');
  });
  it('keeps a received notice visible beside an offline error and escapes task content',()=>{
    state.items=[{id:'notice',workspace_id:'workspace',recipient_id:'user',kind:'assigned',title:'<script>unsafe</script>',
      task_id:'task',project_id:null,payload:{},created_at:'2026-11-14T10:00:00Z',read_at:null}];
    state.problem={kind:'network',message:'Connection unavailable'};
    const html=renderToStaticMarkup(createElement(NotificationsView));
    expect(html).toContain('Connection unavailable');
    expect(html).toContain('1 unread');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Open task');
    expect(html).toContain('Mark read');
  });
  it('distinguishes loading from a confirmed empty inbox',()=>{
    state.loading=true;
    const html=renderToStaticMarkup(createElement(NotificationsView));
    expect(html).toContain('Loading your private notifications');
    expect(html).not.toContain('0 unread');
    expect(html).not.toContain('You’re all caught up');
  });
  it('shows only implemented delivery and leaves administrator controls read-only for members',()=>{
    const html=renderToStaticMarkup(createElement(AutomationView));
    expect(html).toContain('In-app delivery only');
    expect(html).toContain('Managed by workspace owners and admins');
    expect(html).toContain('Preferred time zone');
    expect(html).not.toContain('Save workspace rules');
    expect(html).not.toContain('Recent automation outcomes');
    expect(html).toContain('does not install or verify the server scheduler');
  });
  it('exposes safe operational outcomes and rule controls for administrators',()=>{
    state.role='admin';
    const html=renderToStaticMarkup(createElement(AutomationView));
    expect(html).toContain('Recent automation outcomes');
    expect(html).toContain('Save workspace rules');
    expect(html).toContain('without private payloads');
    expect(html).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('lists outcomes in the shared accessible table with readable labels and no private timing',()=>{
    state.role='owner';
    state.outcomes=[
      {id:'a',kind:'due_soon',state:'retry',attempts:0,created_at:'2026-11-18T00:00:00+00:00',run_after:null,completed_at:null,failed_at:null,last_error:null},
      {id:'b',kind:'assigned',state:'retry',attempts:2,created_at:'2026-11-18T00:00:00+00:00',run_after:'2026-11-18T10:05:00+00:00',completed_at:null,failed_at:null,last_error:'delivery_failed'},
      {id:'c',kind:'awaiting_review',state:'skipped',attempts:1,created_at:'2026-11-17T00:00:00+00:00',run_after:null,completed_at:null,failed_at:null,last_error:null},
    ];
    const html=renderToStaticMarkup(createElement(AutomationView));
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Recent automation jobs');
    expect(html).toContain('Due soon');
    expect(html).toContain('Awaiting review');
    expect(html).not.toContain('due_soon');
    expect(html).toContain('Retrying');
    expect(html).toContain('Scheduled');
    // An older server's 'skipped' is shown as processed, never as a distinct (preference-revealing) state.
    expect(html).not.toContain('Skipped');
    expect(html).toContain('delivery_failed');
    // Day-level creation renders as that date in every viewer zone, with no time of day.
    expect(html).toContain(formatDay('2026-11-18'));
    expect(html).toContain(formatDay('2026-11-17'));
  });
  it('keeps digest figures honest about what they measure',()=>{
    state.items=[{id:'digest',workspace_id:'workspace',recipient_id:'user',kind:'daily',title:'Daily summary',
      task_id:null,project_id:null,payload:{formatVersion:1},created_at:'2026-11-14T10:00:00Z',read_at:null}];
    const html=renderToStaticMarkup(createElement(NotificationsView));
    expect(html).toContain('Read summary');
    // The summary opens in a modal dialog on demand, not as a card appended after the list.
    expect(html).not.toContain('Close summary');
  });
});
