// deno-lint-ignore-file no-explicit-any
import type { ConnectorContext, ConnectorFactory, ProviderKind, SourceConnector } from "./types.ts";
import { googlePhotosFactory } from "./google_photos.ts";
import { localIosFactory } from "./local_ios.ts";
import { exportImportFactory } from "./export_import.ts";
import { dropboxFactory } from "./dropbox.ts";
import { onedriveFactory } from "./onedrive.ts";
import { nasFactory, externalDriveFactory, desktopFolderFactory, icloudFactory, amazonPhotosFactory, localAndroidFactory } from "./stubs.ts";

const REGISTRY: Record<ProviderKind, ConnectorFactory> = {
  google_photos:   googlePhotosFactory,
  local_ios:       localIosFactory,
  local_android:   localAndroidFactory,
  export_import:   exportImportFactory,
  dropbox:         dropboxFactory,
  onedrive:        onedriveFactory,
  nas:             nasFactory,
  external_drive:  externalDriveFactory,
  desktop_folder:  desktopFolderFactory,
  icloud:          icloudFactory,
  amazon_photos:   amazonPhotosFactory,
};

export function getConnector(kind: ProviderKind, ctx: ConnectorContext, supabase: any): SourceConnector {
  const factory = REGISTRY[kind];
  if (!factory) throw new Error(`No connector registered for provider: ${kind}`);
  return factory(ctx, supabase);
}

export const SUPPORTED_PROVIDERS = Object.keys(REGISTRY) as ProviderKind[];