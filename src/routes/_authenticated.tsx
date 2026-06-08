import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/lib/supabase";
import { AppShell } from "@/components/app/AppShell";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ location }) => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
  },
  component: AppShell,
});