import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { runLocalScan, type ProgressUpdate } from "@/lib/metadata-engine";

export const Route = createFileRoute("/_authenticated/scans")({
  component: ScansPage,
});

function ScansPage() {
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [scanning, setScanning] = useState(false);
  const [abort, setAbort] = useState<AbortController | null>(null);
  const [lastScanId, setLastScanId] = useState<string | null>(null);

  const supported = "showDirectoryPicker" in window;

  const startScan = async () => {
    if (!supported) { toast.error("Your browser doesn't support local folder scanning"); return; }
    try {
      // @ts-expect-error — FS Access API
      const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: "read" });
      const ctrl = new AbortController();
      setAbort(ctrl);
      setScanning(true);
      setProgress({ discovered: 0, supported: 0, processed: 0, skipped: 0, errors: 0, currentPath: null, phase: "discovering" });
      const { scanId } = await runLocalScan({
        rootHandle: handle,
        rootLabel: handle.name,
        signal: ctrl.signal,
        onProgress: setProgress,
      });
      setLastScanId(scanId);
      toast.success("Scan complete");
    } catch (e: any) {
      if (e?.name !== "AbortError") toast.error(e?.message ?? "Scan failed");
    } finally {
      setScanning(false);
      setAbort(null);
    }
  };

  const cancel = () => {
    abort?.abort();
    toast.info("Cancelling…");
  };

  const pct = progress?.supported
    ? Math.min(100, Math.round((progress.processed / progress.supported) * 100))
    : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold">Scan a local folder</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          LIFESHOT reads metadata from the files in your selected folder directly in your browser.
          Originals never leave your device.
        </p>
      </header>

      {!supported && (
        <Card className="border-destructive/50 p-4 text-sm">
          Local folder scanning requires the File System Access API (Chrome, Edge, Opera, Brave).
        </Card>
      )}

      <div className="flex gap-3">
        <Button onClick={startScan} disabled={scanning || !supported}>
          {scanning ? "Scanning…" : "Pick a folder"}
        </Button>
        {scanning && <Button variant="outline" onClick={cancel}>Cancel</Button>}
      </div>

      {progress && (
        <Card className="space-y-4 p-4">
          <div className="flex justify-between text-sm">
            <span className="font-medium capitalize">{progress.phase}</span>
            <span className="text-muted-foreground">{pct}%</span>
          </div>
          <Progress value={pct} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
            <Stat label="Discovered" value={progress.discovered} />
            <Stat label="Supported" value={progress.supported} />
            <Stat label="Processed" value={progress.processed} />
            <Stat label="Skipped" value={progress.skipped} />
            <Stat label="Errors" value={progress.errors} />
          </dl>
          {progress.currentPath && (
            <p className="truncate text-xs text-muted-foreground">{progress.currentPath}</p>
          )}
        </Card>
      )}

      {lastScanId && (
        <p className="text-xs text-muted-foreground">Last scan: <code>{lastScanId}</code></p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}