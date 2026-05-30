/**
 * Subscribes to Supabase Realtime updates for a user's source_accounts and
 * job_queue rows so the Sources page reflects sync progress without polling.
 * Invalidates the relevant React Query keys on each change.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth/AuthProvider";

export function useSourceProgress() {
  const qc = useQueryClient();
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`source-progress:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "source_accounts", filter: `user_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: ["source-accounts"] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "job_queue", filter: `user_id=eq.${user.id}` },
        () => {
          qc.invalidateQueries({ queryKey: ["source-accounts"] });
          qc.invalidateQueries({ queryKey: ["dashboard"] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, qc]);
}