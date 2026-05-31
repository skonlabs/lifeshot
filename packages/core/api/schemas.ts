import { z } from "zod";

// ============ shared ============
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(["unauthorized","forbidden","not_found","validation_failed","conflict","rate_limited","dependency_unavailable","internal"]),
    message: z.string(),
    request_id: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export const Cursor = z.string().min(1).optional();

// ============ me ============
export const UserProfileOut = z.object({
  user_id: z.string().uuid(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  tier: z.string(),
  email: z.string().nullable(),
  onboarding_state: z.record(z.unknown()).default({}),
  families: z.array(z.object({
    family_id: z.string().uuid(), name: z.string(), role: z.string(),
  })),
});
export const PatchMe = z.object({
  display_name: z.string().min(1).max(120).optional(),
  avatar_url: z.string().url().max(2048).optional(),
  locale: z.string().min(2).max(20).optional(),
  timezone: z.string().min(1).max(80).optional(),
  onboarding_state: z.record(z.unknown()).optional(),
}).strict();

export const PrivacySettings = z.object({
  ai_enabled: z.boolean(),
  face_processing_enabled: z.boolean(),
  default_visibility: z.enum(["private","family","public"]),
  per_source_overrides: z.record(z.unknown()).default({}),
});
export const PatchPrivacy = PrivacySettings.partial().strict();

// ============ sources ============
export const Provider = z.object({
  id: z.string().uuid(), kind: z.string(), name: z.string(),
  priority: z.string(), capabilities: z.record(z.unknown()),
});
export const ConnectIn = z.object({
  provider_id: z.string().uuid(),
  redirect_uri: z.string().url().max(2048).optional(),
}).strict();
export const ConnectOut = z.object({
  authorize_url: z.string().url().nullable(),
  session_token: z.string().nullable(),
  state: z.string(),
});
export const SourceAccount = z.object({
  id: z.string().uuid(), provider_id: z.string().uuid(), provider_kind: z.string(),
  display_label: z.string().nullable(), status: z.string(),
  connected_at: z.string().nullable(), disconnected_at: z.string().nullable(),
  asset_count: z.number().int(), last_sync_at: z.string().nullable(),
});
export const SourceStatus = z.object({
  account_id: z.string().uuid(), status: z.string(),
  last_job: z.object({
    id: z.string().uuid().nullable(), kind: z.string().nullable(),
    status: z.string().nullable(), started_at: z.string().nullable(),
    finished_at: z.string().nullable(), stats: z.record(z.unknown()),
  }),
  cursor_age_seconds: z.number().int().nullable(),
  last_error: z.string().nullable(),
  progress: z.object({ discovered: z.number().int(), indexed: z.number().int() }),
});

// ============ catalog ============
export const ViewportIn = z.object({
  cursor: Cursor,
  viewport_size: z.number().int().min(1).max(200).default(60),
  timeline_filter: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  people_filter: z.array(z.string().uuid()).optional(),
  event_filter: z.array(z.string().uuid()).optional(),
  source_filter: z.array(z.string().uuid()).optional(),
  quality_preference: z.enum(["best","balanced","fast"]).default("balanced"),
  device_context: z.object({
    dpr: z.number().min(0.5).max(4).optional(),
    network: z.enum(["wifi","cellular","slow"]).optional(),
  }).optional(),
}).strict();

export const AssetDescriptor = z.object({
  asset_id: z.string().uuid(),
  thumbnail_url: z.string().nullable(),
  blurhash: z.string().nullable(),
  dominant_color: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  capture_time: z.string().nullable(),
  media_type: z.string(),
  source_badge: z.string().nullable(),
  hydration_status: z.enum(["pending","ready"]),
  next_quality_url: z.string().nullable(),
  original_fetch_policy: z.enum(["on_demand","never","cached"]),
  cache_status: z.enum(["cold","warm","hot"]),
  prefetch_hint: z.boolean(),
});

export const ViewportOut = z.object({
  items: z.array(AssetDescriptor),
  next_cursor: z.string().nullable(),
  cache: z.object({ hit: z.boolean(), ttl_seconds: z.number().int() }),
});

export const TimelineIn = z.object({
  granularity: z.enum(["year","month","day","event"]).default("month"),
  filters: z.record(z.unknown()).optional(),
});
export const TimelineBucket = z.object({
  bucket: z.string(), asset_count: z.number().int(),
  start_time: z.string().nullable(), end_time: z.string().nullable(),
  cover: AssetDescriptor.nullable(),
});
export const TimelineOut = z.object({ granularity: z.string(), buckets: z.array(TimelineBucket) });

export const DashboardOut = z.object({
  total_assets: z.number().int(),
  at_risk: z.number().int(),
  duplicate_groups: z.number().int(),
  per_year: z.record(z.number().int()),
  per_source: z.record(z.number().int()),
});

// ============ search ============
export const SearchIn = z.object({
  query: z.string().min(1).max(500),
  filters: z.record(z.unknown()).optional(),
  k: z.number().int().min(1).max(200).default(50),
  mode: z.enum(["hybrid","vector","fts"]).default("hybrid"),
}).strict();

export const SearchOut = z.object({
  query_id: z.string().uuid(),
  results: z.array(AssetDescriptor.extend({
    score: z.number(),
    explanation: z.record(z.unknown()),
  })),
  facets: z.record(z.unknown()),
  parsed: z.record(z.unknown()),
  zero_result_suggestions: z.array(z.string()).optional(),
});

export const FacetsIn = z.object({ filters: z.record(z.unknown()).optional() });

// ============ organization ============
export const ListPage = z.object({
  cursor: Cursor, limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const EventSummary = z.object({
  id: z.string().uuid(), title: z.string().nullable(),
  start_time: z.string().nullable(), end_time: z.string().nullable(),
  asset_count: z.number().int(), confidence: z.number().nullable(),
  cover: AssetDescriptor.nullable(),
});
export const PersonSummary = z.object({
  id: z.string().uuid(), display_name: z.string().nullable(),
  asset_count: z.number().int(), consent_required: z.boolean(),
  cover: AssetDescriptor.nullable(),
});
export const PlaceSummary = z.object({
  id: z.string().uuid(), name: z.string(),
  lat: z.number().nullable(), lng: z.number().nullable(),
  asset_count: z.number().int(),
});
export const DuplicateGroup = z.object({
  id: z.string().uuid(), confidence: z.number().nullable(),
  recommended_primary_asset_id: z.string().uuid().nullable(),
  storage_risk: z.string().nullable(), status: z.string(),
  members: z.array(z.object({
    asset_id: z.string().uuid(), match_type: z.string(),
    score: z.number().nullable(), descriptor: AssetDescriptor.nullable(),
  })),
});
export const ConfirmDuplicateIn = z.object({
  action: z.enum(["keep_primary","keep_all","mark_reviewed"]),
  primary_asset_id: z.string().uuid().optional(),
}).strict();
export const CorrectionIn = z.object({
  target_type: z.enum(["asset","person","event","place","duplicate_group"]),
  target_id: z.string().uuid(),
  correction: z.record(z.unknown()),
}).strict();

// ============ family ============
export const CreateFamilyIn = z.object({ name: z.string().min(1).max(120) }).strict();
export const InviteIn = z.object({
  family_id: z.string().uuid(),
  email: z.string().email().max(255),
  role: z.enum(["owner","admin","member","child","guest"]).default("member"),
}).strict();
export const PatchMemberIn = z.object({
  role: z.enum(["owner","admin","member","child","guest"]).optional(),
  status: z.enum(["active","suspended","removed"]).optional(),
}).strict();

// ============ privacy / lifecycle ============
export const ConsentIn = z.object({
  scope: z.enum(["ai_processing","face_recognition","thumbnail_caching","proxy_caching","location_processing","family_sharing","export"]),
  source_account_id: z.string().uuid().optional(),
  granted: z.boolean(),
}).strict();
export const DeleteDerivedIn = z.object({
  scope: z.enum(["all","source","asset"]),
  target_id: z.string().uuid().optional(),
}).strict();
export const DeleteAccountIn = z.object({ confirm: z.literal(true) }).strict();

// inferred types
export type TUserProfileOut = z.infer<typeof UserProfileOut>;
export type TViewportIn = z.infer<typeof ViewportIn>;
export type TViewportOut = z.infer<typeof ViewportOut>;
export type TSearchIn = z.infer<typeof SearchIn>;
export type TSearchOut = z.infer<typeof SearchOut>;
export type TPatchMe = z.infer<typeof PatchMe>;
export type TPrivacySettings = z.infer<typeof PrivacySettings>;
export type TPatchPrivacy = z.infer<typeof PatchPrivacy>;
export type TConsentIn = z.infer<typeof ConsentIn>;
export type TDeleteDerivedIn = z.infer<typeof DeleteDerivedIn>;
export type TSourceStatus = z.infer<typeof SourceStatus>;
export type TSourceAccount = z.infer<typeof SourceAccount>;
export type TProvider = z.infer<typeof Provider>;
export type TTimelineOut = z.infer<typeof TimelineOut>;
export type TDashboardOut = z.infer<typeof DashboardOut>;
export type TDuplicateGroup = z.infer<typeof DuplicateGroup>;
export type TPersonSummary = z.infer<typeof PersonSummary>;
export type TPlaceSummary = z.infer<typeof PlaceSummary>;
export type TEventSummary = z.infer<typeof EventSummary>;
export type TCorrectionIn = z.infer<typeof CorrectionIn>;
export type TConfirmDuplicateIn = z.infer<typeof ConfirmDuplicateIn>;
export type TInviteIn = z.infer<typeof InviteIn>;
export type TPatchMemberIn = z.infer<typeof PatchMemberIn>;
