-- Repair stranded backlog jobs that were inserted without explicit lanes.
-- These jobs sat in lane='default' and were never claimed by ingest/ai-only drains.

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
