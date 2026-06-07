-- Retag previously enqueued backlog jobs that were inserted without an explicit
-- lane, leaving them stranded in the default lane while the worker is nudged
-- against ingest/ai lanes.

update public.job_queue
   set lane = 'ingest', priority = 75
 where status = 'pending'
   and lane = 'default'
   and job_name = 'normalizeMetadata';

update public.job_queue
   set lane = 'ai', priority = 20
 where status = 'pending'
   and lane = 'default'
   and job_name = 'enrichAI';
