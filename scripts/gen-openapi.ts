// Run with: deno run -A scripts/gen-openapi.ts > docs/openapi.json
// Lightweight zod -> OpenAPI 3.1 surface for the route list.
import * as S from "../packages/core/api/schemas.ts";

const paths = {
  "/me": { get: { summary: "Get profile" }, patch: { summary: "Update profile", requestBody: S.PatchMe } },
  "/me/privacy-settings": { get: {}, patch: { requestBody: S.PatchPrivacy } },
  "/sources/providers": { get: {} },
  "/sources/connect": { post: { requestBody: S.ConnectIn } },
  "/sources/callback": { get: {} },
  "/sources/accounts": { get: {} },
  "/sources/{id}/status": { get: {} },
  "/sources/{id}/sync": { post: {} },
  "/sources/{id}": { delete: {} },
  "/catalog/assets/{id}": { get: {} },
  "/catalog/assets/{id}/sources": { get: {} },
  "/catalog/timeline": { get: {} },
  "/catalog/memory/viewport": { post: { requestBody: S.ViewportIn, responseBody: S.ViewportOut } },
  "/catalog/dashboard": { get: { responseBody: S.DashboardOut } },
  "/search": { post: { requestBody: S.SearchIn, responseBody: S.SearchOut } },
  "/search/facets": { get: {} },
  "/search/{query_id}": { get: {} },
  "/organization/events": { get: {} },
  "/organization/events/{id}": { get: {} },
  "/organization/people": { get: {} },
  "/organization/people/{id}": { get: {} },
  "/organization/places": { get: {} },
  "/organization/duplicates": { get: {} },
  "/organization/duplicates/{id}/confirm": { post: { requestBody: S.ConfirmDuplicateIn } },
  "/organization/corrections": { post: { requestBody: S.CorrectionIn } },
  "/families": { post: { requestBody: S.CreateFamilyIn } },
  "/families/invite": { post: { requestBody: S.InviteIn } },
  "/families/{id}": { get: {} },
  "/families/{id}/members/{member_id}": { patch: { requestBody: S.PatchMemberIn } },
  "/privacy/consent": { post: { requestBody: S.ConsentIn } },
  "/privacy/derived-data": { delete: { requestBody: S.DeleteDerivedIn } },
  "/privacy/export": { post: {} },
  "/privacy/account": { delete: { requestBody: S.DeleteAccountIn } },
};

const doc = {
  openapi: "3.1.0",
  info: { title: "LifeShot API", version: "1.0.0" },
  servers: [{ url: "/functions/v1" }],
  paths,
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
};
console.log(JSON.stringify(doc, null, 2));
