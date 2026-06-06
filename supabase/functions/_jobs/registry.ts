import type { JobHandler } from "../_pipeline/runner.ts";
import { syncSource } from "./syncSource.ts";
import { normalizeMetadata } from "./normalizeMetadata.ts";
import { hashAsset } from "./hashAsset.ts";
import { generateDerived } from "./generateDerived.ts";
import { enrichAI } from "./enrichAI.ts";
import { ocrAsset } from "./ocrAsset.ts";
import { indexSearchDocument } from "./indexSearchDocument.ts";
import { materializeTimelineWindows } from "./materializeTimelineWindows.ts";
import { dedupGroup } from "./dedupGroup.ts";
import { clusterPeople } from "./clusterPeople.ts";
import { detectEvents } from "./detectEvents.ts";
import { clusterPlaces } from "./clusterPlaces.ts";
import { disconnectSource } from "./disconnectSource.ts";
import { deleteAccount } from "./deleteAccount.ts";
import { exportUserData } from "./exportUserData.ts";
import { sendInvitationEmail } from "./sendInvitationEmail.ts";

export const JOB_HANDLERS = {
  syncSource,
  normalizeMetadata,
  hashAsset,
  generateDerived,
  enrichAI,
  ocrAsset,
  indexSearchDocument,
  materializeTimelineWindows,
  dedupGroup,
  clusterPeople,
  detectEvents,
  clusterPlaces,
  disconnectSource,
  deleteAccount,
  exportUserData,
  sendInvitationEmail,
} satisfies Record<string, JobHandler>;

export type JobName = keyof typeof JOB_HANDLERS;
export const ALL_JOB_NAMES = Object.keys(JOB_HANDLERS) as JobName[];