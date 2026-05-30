import type { ProviderId, SourceConnector } from "./types";
import { googlePhotosConnector } from "./google-photos/connector";
import { dropboxConnector } from "./dropbox/connector";
import { deviceConnector } from "./device/connector";

export const connectors: Record<ProviderId, SourceConnector | undefined> = {
  google_photos: googlePhotosConnector,
  dropbox: dropboxConnector,
  ios_device: deviceConnector("ios_device"),
  android_device: deviceConnector("android_device"),
  onedrive: undefined,
  desktop_folder: undefined,
  whatsapp_import: undefined,
  fb_export: undefined,
  ig_export: undefined,
};

export function getConnector(id: ProviderId): SourceConnector {
  const c = connectors[id];
  if (!c) throw new Error(`Connector not implemented: ${id}`);
  return c;
}

export const providerCatalog: Array<{
  id: ProviderId;
  displayName: string;
  available: boolean;
  status: "P0" | "P1" | "P2";
  note?: string;
}> = [
  { id: "google_photos", displayName: "Google Photos", available: true, status: "P0" },
  { id: "ios_device", displayName: "iPhone / iPad (via app)", available: true, status: "P0", note: "Use the LifeShot iOS app" },
  { id: "android_device", displayName: "Android (via app)", available: true, status: "P0", note: "Use the LifeShot Android app" },
  { id: "dropbox", displayName: "Dropbox", available: true, status: "P0" },
  { id: "onedrive", displayName: "Microsoft OneDrive", available: false, status: "P1" },
  { id: "desktop_folder", displayName: "Desktop folder", available: false, status: "P1", note: "Requires LifeShot desktop agent" },
  { id: "whatsapp_import", displayName: "WhatsApp media", available: false, status: "P1", note: "Import via chat export ZIP" },
  { id: "fb_export", displayName: "Facebook export", available: false, status: "P2" },
  { id: "ig_export", displayName: "Instagram export", available: false, status: "P2" },
];