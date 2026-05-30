import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/callback")({ component: Callback });

function Callback() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      navigate({ to: data.session ? "/library" : "/sign-in" });
    });
  }, [navigate]);
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Finishing sign-in…
    </div>
  );
}