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
  // Official Google Photos pinwheel — 4 rounded petals
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#FBBC04" d="M12 4a12 12 0 0 1 12 12v8h-8a12 12 0 0 1-12-12V4h8z" />
      <path fill="#EA4335" d="M44 12a12 12 0 0 1-12 12h-8v-8A12 12 0 0 1 36 4h8v8z" />
      <path fill="#34A853" d="M36 44a12 12 0 0 1-12-12v-8h8a12 12 0 0 1 12 12v8h-8z" />
      <path fill="#4285F4" d="M4 36a12 12 0 0 1 12-12h8v8a12 12 0 0 1-12 12H4v-8z" />
    </svg>
  );
}

function Dropbox({ className }: { className?: string }) {
  // Official Dropbox glyph: two stacked open boxes
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path fill="#0061FF" d="M8 2 0 7.2l8 5.2 8-5.2L8 2zm16 0-8 5.2 8 5.2 8-5.2L24 2zM0 17.6l8 5.2 8-5.2-8-5.2-8 5.2zm24-5.2-8 5.2 8 5.2 8-5.2-8-5.2zM8 24.4l8 5.2 8-5.2-8-5.2-8 5.2z"/>
    </svg>
  );
}

function OneDrive({ className }: { className?: string }) {
  // Microsoft OneDrive cloud — multi-blue
  return (
    <svg viewBox="0 0 48 32" className={className} aria-hidden="true">
      <path fill="#0364B8" d="M30 8a10 10 0 0 0-9.5 6.9A8 8 0 0 0 14 18l13 2 8-4a8 8 0 0 0-5-8z"/>
      <path fill="#0078D4" d="M20.5 14.9A8 8 0 0 0 13 20l11 4 11-4a8 8 0 0 0-5.5-5.1A10 10 0 0 0 20.5 14.9z"/>
      <path fill="#1490DF" d="M35 16a8 8 0 0 1 8 8l-9 6H13l-3-8 3-2 22 0z"/>
      <path fill="#28A8EA" d="M13 18a7 7 0 0 0-7 7 5 5 0 0 0 5 5h25l4-6-5-6-22 0z"/>
    </svg>
  );
}

function AmazonPhotos({ className }: { className?: string }) {
  // Amazon smile
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="#232F3E" />
      <path fill="#FF9900" d="M11 31c7 5 19 5 26 0l1.4 1.6c-7.8 6.4-21 6.4-28.8 0L11 31z"/>
      <path fill="#FF9900" d="M37 33c1.2-1.2 2-3 1.4-3.6-.7-.8-3.4-.4-4.6.2l.2-.6c1.4-1 4.4-1.4 5.4-.4 1 1.2-.2 4-1.6 4.8l-.8-.4z"/>
      <path fill="#fff" d="M16 22c0-3 2-5 5-5 2 0 3.4 1 4 2.4V17h3v10h-3v-1.2c-.8 1-2.2 1.6-3.8 1.6-3 0-5.2-2-5.2-5.4zm5 2.6c1.6 0 2.8-1 2.8-2.6S22.6 19.4 21 19.4s-2.8 1-2.8 2.6S19.4 24.6 21 24.6z"/>
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