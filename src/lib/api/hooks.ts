/**
 * TanStack Query hooks wrapping the LifeShot API. Server state lives here;
 * never duplicate into Zustand. Query keys always include the relevant
 * filter hash so cache invalidation is precise.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  TSearchIn,
  TSearchOut,
  TViewportIn,
  TViewportOut,
  TUserProfileOut,
  TPatchMe,
  TPrivacySettings,
  TPatchPrivacy,
  TConsentIn,
  TDeleteDerivedIn,
  TSourceStatus,
} from "@core/api";
import { api } from "./client";

// ---------- me / privacy ----------
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.me<TUserProfileOut>("/me"),
    staleTime: 60_000,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TPatchMe) =>
      api.me<TUserProfileOut>("/me", { method: "PATCH", body }),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
      qc.invalidateQueries({ queryKey: ["families"] });
    },
  });
}

export function usePrivacySettings() {
  return useQuery({
    queryKey: ["privacy-settings"],
    queryFn: () => api.me<TPrivacySettings>("/privacy-settings"),
    staleTime: 60_000,
  });
}

export function useUpdatePrivacy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TPatchPrivacy) =>
      api.me<TPrivacySettings>("/privacy-settings", { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["privacy-settings"] }),
  });
}

export function useGrantConsent() {
  const qc = useQueryClient();
  return useMutation({
    // /consent lives on the privacy edge function, not /me.
    mutationFn: (body: TConsentIn) =>
      api.privacy("/consent", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["privacy-settings"] }),
  });
}

// ---------- catalog ----------
export function useViewport(filters: Partial<TViewportIn>) {
  return useInfiniteQuery({
    queryKey: ["viewport", filters],
    queryFn: ({ pageParam }) =>
      api.catalog<TViewportOut>("/memory/viewport", {
        method: "POST",
        body: { ...filters, cursor: pageParam ?? undefined, viewport_size: filters.viewport_size ?? 60 },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useTimeline(granularity: "year" | "month" | "day" | "event" = "month") {
  return useQuery({
    queryKey: ["timeline", granularity],
    queryFn: () => api.catalog<{ granularity: string; buckets: Array<{ bucket: string; asset_count: number }> }>(
      "/timeline",
      { method: "GET", query: { granularity } },
    ),
    staleTime: 60_000,
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.catalog<{ total_assets: number; at_risk: number; duplicate_groups: number; per_year: Record<string, number>; per_source: Record<string, number> }>("/dashboard"),
    staleTime: 60_000,
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: ["asset", id],
    enabled: !!id,
    queryFn: () => api.catalog<{ asset: Record<string, unknown>; descriptor: Record<string, unknown> }>(`/assets/${id}`),
  });
}

export function useAssetSources(id: string | undefined) {
  return useQuery({
    queryKey: ["asset-sources", id],
    enabled: !!id,
    queryFn: () => api.catalog<{ sources: Array<Record<string, unknown>> }>(`/assets/${id}/sources`),
  });
}

// ---------- search ----------
export function useSearch(input: TSearchIn | null) {
  return useQuery({
    queryKey: ["search", input],
    enabled: !!input,
    queryFn: () => api.search<TSearchOut>("/search", { method: "POST", body: input! }),
    staleTime: 30_000,
  });
}

export function useReplaySearch(queryId: string | null) {
  return useQuery({
    queryKey: ["search-replay", queryId],
    enabled: !!queryId,
    queryFn: () => api.search<TSearchOut>(`/search/${queryId}`),
  });
}

// ---------- sources ----------
export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => api.sources<{ providers: Array<{ id: string; kind: string; name: string; priority: string }> }>("/providers"),
    staleTime: 5 * 60_000,
  });
}

export function useSourceAccounts() {
  return useQuery({
    queryKey: ["source-accounts"],
    queryFn: () => api.sources<{ accounts: Array<{ id: string; provider_kind: string; status: string; display_label: string | null; asset_count: number; last_sync_at: string | null }> }>("/accounts"),
    staleTime: 30_000,
  });
}

export function useConnectSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider_id: string; redirect_uri?: string }) =>
      api.sources<{ authorize_url: string | null; session_token: string | null; state: string }>("/connect", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source-accounts"] }),
  });
}

export function useSyncSource() {
  const qc = useQueryClient();
  return useMutation({
    // Backend mounts as POST /:id/sync, not /accounts/:id/sync.
    mutationFn: (accountId: string) =>
      api.sources(`/${accountId}/sync`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source-accounts"] }),
  });
}

export function useDisconnectSource() {
  const qc = useQueryClient();
  return useMutation({
    // Backend mounts as DELETE /:id, not /accounts/:id.
    mutationFn: (accountId: string) =>
      api.sources(`/${accountId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source-accounts"] }),
  });
}

export function useSourceStatus(accountId: string | undefined) {
  return useQuery({
    queryKey: ["source-status", accountId],
    enabled: !!accountId,
    queryFn: () => api.sources<TSourceStatus>(`/${accountId}/status`),
    // Only poll while a job is actively running. Once it completes/fails,
    // stop hammering the backend.
    refetchInterval: (q) => {
      const s = (q.state.data as TSourceStatus | undefined);
      const status = s?.last_job?.status;
      const accStatus = s?.status;
      const running = status === "running" || status === "pending" || accStatus === "syncing";
      return running ? 5_000 : false;
    },
  });
}

// ---------- organization ----------
export function useDuplicates() {
  return useQuery({
    queryKey: ["duplicates"],
    queryFn: () => api.organization<{ groups: Array<{ id: string; confidence: number | null; recommended_primary_asset_id: string | null; storage_risk: string | null; status: string; members: Array<{ asset_id: string; match_type: string; score: number | null }> }> }>("/duplicates"),
  });
}

export function useConfirmDuplicate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { action: "keep_primary" | "keep_all" | "mark_reviewed"; primary_asset_id?: string } }) =>
      api.organization(`/duplicates/${id}/confirm`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["duplicates"] }),
  });
}

export function usePeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: () => api.organization<{ people: Array<{ id: string; display_name: string | null; asset_count: number; consent_required: boolean }> }>("/people"),
  });
}

export function usePerson(id: string | undefined) {
  return useQuery({
    queryKey: ["person", id],
    enabled: !!id,
    queryFn: () => api.organization<Record<string, unknown>>(`/people/${id}`),
  });
}

export function usePlaces() {
  return useQuery({
    queryKey: ["places"],
    queryFn: () => api.organization<{ places: Array<{ id: string; name: string; lat: number | null; lng: number | null; asset_count: number }> }>("/places"),
  });
}

export function useEvents() {
  return useQuery({
    queryKey: ["events"],
    queryFn: () => api.organization<{ events: Array<{ id: string; title: string | null; start_time: string | null; end_time: string | null; asset_count: number; confidence: number | null }> }>("/events"),
  });
}

export function useEvent(id: string | undefined) {
  return useQuery({
    queryKey: ["event", id],
    enabled: !!id,
    queryFn: () => api.organization<Record<string, unknown>>(`/events/${id}`),
  });
}

export function useCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { target_type: string; target_id: string; correction: Record<string, unknown> }) =>
      api.organization("/corrections", { method: "POST", body }),
    onMutate: async (vars) => {
      // Optimistically apply a display_name rename for people.
      if (vars.target_type === "person" && typeof vars.correction?.display_name === "string") {
        await qc.cancelQueries({ queryKey: ["people"] });
        await qc.cancelQueries({ queryKey: ["person", vars.target_id] });
        const prevList = qc.getQueryData<{ people: Array<{ id: string; display_name: string | null }> }>(["people"]);
        const prevPerson = qc.getQueryData<Record<string, unknown>>(["person", vars.target_id]);
        if (prevList) {
          qc.setQueryData(["people"], {
            ...prevList,
            people: prevList.people.map((p) =>
              p.id === vars.target_id ? { ...p, display_name: vars.correction.display_name as string } : p,
            ),
          });
        }
        if (prevPerson) {
          qc.setQueryData(["person", vars.target_id], { ...prevPerson, display_name: vars.correction.display_name });
        }
        return { prevList, prevPerson };
      }
      return {};
    },
    onError: (_e, vars, ctx) => {
      const c = ctx as { prevList?: unknown; prevPerson?: unknown } | undefined;
      if (c?.prevList) qc.setQueryData(["people"], c.prevList);
      if (c?.prevPerson) qc.setQueryData(["person", vars.target_id], c.prevPerson);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["duplicates"] });
    },
  });
}

// ---------- families ----------
/**
 * The /me payload already includes the user's families. The families function
 * has no GET /families list endpoint, so derive from useMe() instead.
 */
export function useFamilies() {
  const me = useMe();
  return {
    ...me,
    data: me.data
      ? {
          families: me.data.families.map((f) => ({
            id: f.family_id,
            name: f.name,
            role: f.role,
          })),
        }
      : undefined,
  };
}

export function useFamilyDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["family", id],
    enabled: !!id,
    queryFn: () =>
      api.families<{ family: { id: string; name: string }; members: Array<{ id: string; user_id: string; role: string; status: string; display_name: string | null }> }>(`/${id}`),
  });
}

export function useCreateFamily() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => api.families("/families", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useInviteToFamily() {
  return useMutation({
    // Backend mounts at POST /invite, not /invitations.
    mutationFn: (body: { family_id: string; email: string; role?: string }) =>
      api.families("/invite", { method: "POST", body }),
  });
}

export function usePatchFamilyMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ familyId, memberId, body }: { familyId: string; memberId: string; body: { role?: string; status?: string } }) =>
      api.families(`/${familyId}/members/${memberId}`, { method: "PATCH", body }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["family", v.familyId] }),
  });
}

// ---------- privacy / lifecycle ----------
export function useExportData() {
  return useMutation({
    mutationFn: () => api.privacy<{ job_id: string; status: string }>("/export", { method: "POST", body: {} }),
  });
}

export function useDeleteDerivedData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TDeleteDerivedIn) =>
      api.privacy<{ deleted: number }>("/derived-data", { method: "DELETE", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["viewport"] });
    },
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: () => api.privacy("/account", { method: "DELETE", body: { confirm: true } }),
  });
}