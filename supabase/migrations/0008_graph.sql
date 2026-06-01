-- 0008_graph.sql -- Memory graph nodes/edges + snapshots

create table public.memory_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  node_type node_type not null,
  ref_id uuid,
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or family_id is not null)
);
comment on table public.memory_nodes is 'Graph node referencing an asset/person/place/event/etc.';
create index idx_memory_nodes_user_type on public.memory_nodes(user_id, node_type);
create index idx_memory_nodes_ref on public.memory_nodes(ref_id);
create trigger trg_memory_nodes_updated before update on public.memory_nodes for each row execute function public.set_updated_at();

create table public.memory_edges (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references public.memory_nodes(id) on delete cascade,
  to_node_id uuid not null references public.memory_nodes(id) on delete cascade,
  edge_type edge_type not null,
  weight numeric default 1,
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.memory_edges is 'Directed edge in the memory graph.';
create index idx_memory_edges_from on public.memory_edges(from_node_id, edge_type);
create index idx_memory_edges_to on public.memory_edges(to_node_id, edge_type);
create trigger trg_memory_edges_updated before update on public.memory_edges for each row execute function public.set_updated_at();

create table public.graph_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
comment on table public.graph_snapshots is 'Periodic snapshot of the user''s memory graph.';
create index idx_graph_snapshots_user on public.graph_snapshots(user_id, created_at desc);
