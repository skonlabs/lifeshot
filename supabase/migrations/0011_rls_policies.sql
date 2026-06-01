-- 0011_rls_policies.sql -- Enable RLS + policies + grants on every table.
-- Conventions: owner = auth.uid() = user_id. Family rows visible to active
-- members. source_tokens has NO policy (service_role only).

-- Helper: asset access (owner or family-shared)
create or replace function public.can_access_asset(_asset_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assets a
     where a.id = _asset_id
       and a.deleted_state = 'active'
       and (
         a.user_id = auth.uid()
         or (a.family_id is not null
             and a.visibility_state in ('family','public')
             and public.is_family_member(a.family_id))
       )
  );
$$;

-- ---------- helper for default grants ----------
do $$
declare t text;
declare owner_tables text[] := array[
  'user_profiles','families','family_members','family_invitations',
  'consent_records','privacy_settings',
  'source_providers','source_accounts','source_permissions',
  'source_capabilities','source_sync_jobs','source_sync_cursors','source_errors',
  'assets','asset_source_refs','asset_metadata','asset_exif','asset_locations',
  'asset_devices','asset_albums','asset_album_memberships','asset_quality_scores',
  'asset_visibility','asset_thumbnails','asset_proxies','asset_blurhashes',
  'asset_cache_status','asset_embeddings','asset_ocr','asset_labels',
  'asset_captions','asset_search_documents','search_queries','search_result_cache',
  'duplicate_groups','duplicate_group_members','people','person_faces',
  'face_clusters','places','events','event_assets','event_people','event_places',
  'timeline_windows','smart_collections','collection_assets','user_corrections',
  'memory_nodes','memory_edges','graph_snapshots','ingestion_events',
  'audit_logs','user_activity_events','performance_metrics','source_tokens'
];
begin
  foreach t in array owner_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- source_providers is reference data: anon may read
grant select on public.source_providers to anon;
create policy source_providers_read_all on public.source_providers for select to anon, authenticated using (true);

-- =================== USER-OWNED ===================
create policy up_owner_all on public.user_profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy fam_owner_select on public.families for select to authenticated
  using (owner_user_id = auth.uid() or public.is_family_member(id));
create policy fam_owner_modify on public.families for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create policy fm_self_select on public.family_members for select to authenticated
  using (user_id = auth.uid() or public.is_family_member(family_id));
create policy fm_owner_modify on public.family_members for all to authenticated
  using (exists (select 1 from public.families f where f.id = family_id and f.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.families f where f.id = family_id and f.owner_user_id = auth.uid()));

create policy fi_owner_all on public.family_invitations for all to authenticated
  using (exists (select 1 from public.families f where f.id = family_id and f.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.families f where f.id = family_id and f.owner_user_id = auth.uid()));

create policy consent_owner_all on public.consent_records for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy privacy_owner_all on public.privacy_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =================== SOURCES ===================
create policy sa_owner_all on public.source_accounts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- source_tokens: NO policy at all -> only service_role can access (RLS enabled, default deny)

create policy sp_owner_all on public.source_permissions for all to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()))
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

create policy sc_owner_all on public.source_capabilities for select to authenticated
  using (
    source_account_id is null
    or exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid())
  );

create policy ssj_owner_all on public.source_sync_jobs for all to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()))
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

create policy ssc_owner_all on public.source_sync_cursors for all to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()))
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

create policy se_owner_all on public.source_errors for all to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()))
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

-- =================== ASSETS + DERIVED ===================
create policy assets_owner_select on public.assets for select to authenticated
  using (
    deleted_state = 'active'
    and (
      user_id = auth.uid()
      or (family_id is not null and visibility_state in ('family','public') and public.is_family_member(family_id))
    )
  );
create policy assets_owner_modify on public.assets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- For each derived table, gate by can_access_asset
do $$
declare t text;
declare derived text[] := array[
  'asset_source_refs','asset_metadata','asset_exif','asset_locations','asset_devices',
  'asset_album_memberships','asset_quality_scores','asset_visibility',
  'asset_thumbnails','asset_proxies','asset_blurhashes','asset_cache_status',
  'asset_embeddings','asset_ocr','asset_labels','asset_captions',
  'duplicate_group_members','person_faces','event_assets','collection_assets'
];
begin
  foreach t in array derived loop
    execute format($f$
      create policy %1$I_read on public.%1$I for select to authenticated
        using (public.can_access_asset(asset_id));
      create policy %1$I_modify on public.%1$I for all to authenticated
        using (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()))
        with check (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

-- asset_search_documents has user_id directly
create policy asd_owner_all on public.asset_search_documents for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- asset_albums by source_account ownership
create policy aa_owner_all on public.asset_albums for all to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()))
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

-- search_queries / cache (owner-only)
create policy sq_owner_all on public.search_queries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy src_owner_all on public.search_result_cache for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =================== ORGANIZATION ===================
create policy dg_owner_all on public.duplicate_groups for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy people_access on public.people for select to authenticated
  using (user_id = auth.uid() or (family_id is not null and public.is_family_member(family_id)));
create policy people_modify on public.people for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy fc_owner_all on public.face_clusters for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy places_access on public.places for select to authenticated
  using (user_id = auth.uid() or (family_id is not null and public.is_family_member(family_id)));
create policy places_modify on public.places for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy events_access on public.events for select to authenticated
  using (user_id = auth.uid() or (family_id is not null and public.is_family_member(family_id)));
create policy events_modify on public.events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy ep_read on public.event_people for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and (e.user_id = auth.uid() or public.is_family_member(e.family_id))));
create policy ep_modify on public.event_people for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));

create policy eplaces_read on public.event_places for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and (e.user_id = auth.uid() or public.is_family_member(e.family_id))));
create policy eplaces_modify on public.event_places for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));

create policy tw_owner_all on public.timeline_windows for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy sm_access on public.smart_collections for select to authenticated
  using (user_id = auth.uid() or (family_id is not null and public.is_family_member(family_id)));
create policy sm_modify on public.smart_collections for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy uc_owner_all on public.user_corrections for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =================== GRAPH ===================
create policy mn_access on public.memory_nodes for select to authenticated
  using (user_id = auth.uid() or (family_id is not null and public.is_family_member(family_id)));
create policy mn_modify on public.memory_nodes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy me_access on public.memory_edges for select to authenticated
  using (exists (select 1 from public.memory_nodes n where n.id = from_node_id
                  and (n.user_id = auth.uid() or public.is_family_member(n.family_id))));
create policy me_modify on public.memory_edges for all to authenticated
  using (exists (select 1 from public.memory_nodes n where n.id = from_node_id and n.user_id = auth.uid()))
  with check (exists (select 1 from public.memory_nodes n where n.id = from_node_id and n.user_id = auth.uid()));

create policy gs_owner_all on public.graph_snapshots for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =================== OBSERVABILITY ===================
create policy ie_owner_read on public.ingestion_events for select to authenticated
  using (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));
create policy ie_owner_insert on public.ingestion_events for insert to authenticated
  with check (exists (select 1 from public.source_accounts sa where sa.id = source_account_id and sa.user_id = auth.uid()));

-- audit_logs: append-only. Owner reads. No update/delete policy.
create policy audit_owner_select on public.audit_logs for select to authenticated
  using (user_id = auth.uid());
create policy audit_owner_insert on public.audit_logs for insert to authenticated
  with check (user_id = auth.uid());

create policy uae_owner_all on public.user_activity_events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- performance_metrics: service_role only (no policy)
