-- Compatibility shim for older deployed workers that may still call
-- public.source_take_token(uuid, int) after source_rate_buckets was removed.
--
-- New code paths use the in-memory limiter in supabase/functions/_pipeline/ratelimit.ts.
-- This migration only prevents stale deployments from crashing while the new
-- worker code propagates everywhere.

CREATE TABLE IF NOT EXISTS public.source_rate_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES public.source_accounts(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_account_id, window_start)
);

GRANT ALL ON public.source_rate_buckets TO service_role;
ALTER TABLE public.source_rate_buckets ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_rate_buckets_window
  ON public.source_rate_buckets(source_account_id, window_start DESC);

CREATE OR REPLACE FUNCTION public.source_take_token(_source_account_id uuid, _per_min int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now timestamptz := now();
  _start timestamptz := date_trunc('minute', _now);
  _cnt integer;
BEGIN
  INSERT INTO public.source_rate_buckets(source_account_id, window_start, count)
  VALUES (_source_account_id, _start, 1)
  ON CONFLICT (source_account_id, window_start) DO UPDATE
    SET count = source_rate_buckets.count + 1,
        updated_at = now()
  RETURNING count INTO _cnt;

  DELETE FROM public.source_rate_buckets
  WHERE source_account_id = _source_account_id
    AND window_start < _now - interval '5 minutes';

  RETURN _cnt <= GREATEST(COALESCE(_per_min, 0), 1);
END;
$$;

GRANT EXECUTE ON FUNCTION public.source_take_token(uuid, int) TO service_role;
