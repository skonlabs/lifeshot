// deno-lint-ignore-file no-explicit-any
import { providers } from "./mocks.ts";
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function sendInvitationEmail(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { invitation_id } = ctx.payload as { invitation_id: string };
  const { data: inv } = await sb.from("family_invitations")
    .select("id, email, token").eq("id", invitation_id).single();
  if (!inv) throw new Error("not found: invitation");
  const r = await providers.email.send({
    to: inv.email,
    subject: "You've been invited to a Lifeshot family",
    html: `<p>You've been invited. <a href="${Deno.env.get('APP_BASE_URL') ?? ''}/invite/${inv.token}">Accept</a></p>`,
    text: `Accept your Lifeshot family invite: ${Deno.env.get('APP_BASE_URL') ?? ''}/invite/${inv.token}`,
  });
  await sb.from("family_invitations").update({ last_sent_at: new Date().toISOString(), email_message_id: r.id }).eq("id", invitation_id);
  return { invitation_id, email_id: r.id };
}