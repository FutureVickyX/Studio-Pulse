-- Hosting prerequisites only; no schedule, URL, invocation key or delivery is activated here.
-- Portable test Postgres distributions without these optional extensions simply skip them.
do $$ begin
 if exists(select 1 from pg_catalog.pg_available_extensions where name='pg_cron') then
   create extension if not exists pg_cron with schema pg_catalog;
 end if;
 if exists(select 1 from pg_catalog.pg_available_extensions where name='pg_net') then
   create extension if not exists pg_net with schema extensions;
   revoke all on net.http_request_queue,net._http_response from public,anon,authenticated;
 end if;
end; $$;
