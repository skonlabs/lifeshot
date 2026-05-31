import {
  Apple,
  Cloud,
  HardDrive,
  Image as ImageIcon,
  Monitor,
  Server,
  Smartphone,
  Upload,
} from "lucide-react";

function GooglePhotos({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#FBBC04" d="M12 4a12 12 0 0 1 12 12H12V4z" />
      <path fill="#34A853" d="M44 24a12 12 0 0 1-12 12V24h12z" />
      <path fill="#4285F4" d="M24 44a12 12 0 0 1-12-12h12v12z" />
      <path fill="#EA4335" d="M4 24a12 12 0 0 1 12-12v12H4z" />
    </svg>
  );
}

function Dropbox({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#0061FF" d="M14 6 4 13l10 7 10-7-10-7zM34 6l-10 7 10 7 10-7-10-7zM4 27l10 7 10-7-10-7-10 7zM34 20l-10 7 10 7 10-7-10-7zM14 36l10 7 10-7-10-7-10 7z" />
    </svg>
  );
}

function OneDrive({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#0364B8" d="M28 14a10 10 0 0 1 9.7 7.6A8 8 0 0 1 36 37H14a8 8 0 0 1-2.4-15.6A10 10 0 0 1 28 14z" />
      <path fill="#0078D4" d="M37.7 21.6A8 8 0 0 1 36 37H22V20.5A10 10 0 0 1 37.7 21.6z" />
    </svg>
  );
}

function AmazonPhotos({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect width="48" height="48" rx="8" fill="#232F3E" />
      <path fill="#FF9900" d="M10 32c8 5 20 5 28 0l-1 2c-7 5-19 5-27 0v-2z" />
      <circle cx="24" cy="20" r="6" fill="#FF9900" />
    </svg>
  );
}

export function ProviderIcon({ kind, className = "h-5 w-5" }: { kind: string; className?: string }) {
  switch (kind) {
    case "google_photos":
      return <GooglePhotos className={className} />;
    case "dropbox":
      return <Dropbox className={className} />;
    case "onedrive":
      return <OneDrive className={className} />;
    case "amazon_photos":
      return <AmazonPhotos className={className} />;
    case "icloud":
      return <Cloud className={className} strokeWidth={1.5} />;
    case "local_ios":
      return <Apple className={className} strokeWidth={1.5} />;
    case "local_android":
      return <Smartphone className={className} strokeWidth={1.5} />;
    case "desktop_folder":
      return <Monitor className={className} strokeWidth={1.5} />;
    case "external_drive":
      return <HardDrive className={className} strokeWidth={1.5} />;
    case "nas":
      return <Server className={className} strokeWidth={1.5} />;
    case "export_import":
      return <Upload className={className} strokeWidth={1.5} />;
    default:
      return <ImageIcon className={className} strokeWidth={1.5} />;
  }
}