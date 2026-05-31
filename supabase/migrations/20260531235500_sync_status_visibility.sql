grant select, insert, update, delete on public.source_sync_jobs to authenticated;
grant all on public.source_sync_jobs to service_role;

grant select, insert, update, delete on public.source_sync_cursors to authenticated;
grant all on public.source_sync_cursors to service_role;

grant select, insert, update, delete on public.source_errors to authenticated;
grant all on public.source_errors to service_role;
