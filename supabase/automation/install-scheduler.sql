-- Run as the trusted database operator AFTER migrations 10-12 and the Edge deployment.
-- Re-running replaces the same named job. No application computer needs to stay awake.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Configure only the public project URL before running this script:
-- select vault.create_secret('https://YOUR_PROJECT.supabase.co','studio_pulse_automation_url');
-- The limited invocation key is generated here, stays in Vault and is never returned.
do $$
declare invocation_key text;
begin
 if not exists(select 1 from vault.decrypted_secrets where name='studio_pulse_automation_url'
   and decrypted_secret ~ '^https://[a-z0-9]+\.supabase\.co$') then
   raise exception 'Set the studio_pulse_automation_url Vault secret to the public project URL first';
 end if;
 select decrypted_secret into invocation_key from vault.decrypted_secrets where name='studio_pulse_automation_key';
 if invocation_key is null then
   invocation_key:=encode(extensions.gen_random_bytes(32),'hex');
   perform vault.create_secret(invocation_key,'studio_pulse_automation_key','Limited automation invocation credential');
 end if;
 if invocation_key !~ '^[0-9a-f]{64}$' then raise exception 'Invalid scheduler credential format'; end if;
 insert into private.automation_worker_keys(key_hash) values(sha256(convert_to(invocation_key,'UTF8'))) on conflict do nothing;
end; $$;

-- pg_net temporarily queues the decrypted LIMITED key, never a service-role credential.
revoke all on net.http_request_queue,net._http_response from public,anon,authenticated;

select cron.schedule('studio-pulse-automation','* * * * *',$schedule$
 select net.http_post(
   url:=(select decrypted_secret from vault.decrypted_secrets where name='studio_pulse_automation_url')||'/functions/v1/automation-worker',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
     (select decrypted_secret from vault.decrypted_secrets where name='studio_pulse_automation_key')),
   body:='{}'::jsonb,timeout_milliseconds:=15000
 );
$schedule$);
commit;
