-- Operator-only diagnostics. These queries do not expose the Vault key or HTTP headers.
select jobname,schedule,active from cron.job where jobname='studio-pulse-automation';
select r.status,r.start_time,r.end_time,r.return_message from cron.job_run_details r
join cron.job j using(jobid) where j.jobname='studio-pulse-automation' order by r.start_time desc limit 10;
select status_code,timed_out,error_msg,created from net._http_response order by created desc limit 10;
select state,count(*) from private.automation_jobs group by state;
select kind,state,attempts,last_error,created_at,completed_at,failed_at from private.automation_jobs order by created_at desc limit 20;

-- A successful cron SQL run only means HTTP was queued. Require an HTTP 200 AND a
-- confirmed delivered notification from a test event before declaring deployment verified.
