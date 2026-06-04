update public.job_queue
   set priority = 100
 where job_name = 'syncSource'
   and status = 'pending'
   and lane = 'user'
   and priority < 100;
