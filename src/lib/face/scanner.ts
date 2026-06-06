/**
 * Browser face scanner — pulls unscanned assets from the server, runs
 * face-api.js detection on each image, and submits the descriptors +
 * aligned face crops back to the server for clustering.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api/client";
import { detectFaces, loadFaceModels } from "./detector";

interface QueueResponse {
  assets: Array<{ id: string; image_url: string; width: number | null; height: number | null }>;
  face_processing_disabled?: boolean;
}

interface SubmitResponse {
  ok: boolean;
  faces: number;
}

const BATCH_SIZE = 8;

export interface ScanState {
  status: "idle" | "loading-models" | "scanning" | "done" | "disabled" | "error";
  scanned: number;
  faces: number;
  remaining: number;
  error: string | null;
}

export function useFaceScanner() {
  const qc = useQueryClient();
  const [state, setState] = useState<ScanState>({
    status: "idle",
    scanned: 0,
    faces: 0,
    remaining: 0,
    error: null,
  });
  const runningRef = useRef(false);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState((s) => ({ ...s, status: "loading-models", error: null }));

    try {
      await loadFaceModels();
    } catch (e) {
      runningRef.current = false;
      setState((s) => ({ ...s, status: "error", error: `Model load failed: ${(e as Error).message}` }));
      return;
    }

    setState((s) => ({ ...s, status: "scanning" }));

    let totalScanned = 0;
    let totalFaces = 0;

    try {
      while (true) {
        const queue = await api.organization<QueueResponse>("/face-scan/queue", {
          query: { limit: BATCH_SIZE },
        });
        if (queue.face_processing_disabled) {
          setState({ status: "disabled", scanned: totalScanned, faces: totalFaces, remaining: 0, error: null });
          return;
        }
        if (!queue.assets.length) break;

        setState((s) => ({ ...s, remaining: queue.assets.length }));

        for (const asset of queue.assets) {
          try {
            const result = await detectFaces(asset.image_url);
            await api.organization<SubmitResponse>("/face-scan/submit", {
              method: "POST",
              body: {
                asset_id: asset.id,
                image_width: result.imageWidth,
                image_height: result.imageHeight,
                faces: result.faces.map((f) => ({
                  descriptor: f.descriptor,
                  score: f.score,
                  box: f.box,
                  dataUrl: f.dataUrl,
                })),
              },
            });
            totalScanned += 1;
            totalFaces += result.faces.length;
            setState({
              status: "scanning",
              scanned: totalScanned,
              faces: totalFaces,
              remaining: queue.assets.length - 1,
              error: null,
            });
          } catch (e) {
            // Mark as scanned-with-zero so we don't loop forever on broken images.
            try {
              await api.organization<SubmitResponse>("/face-scan/submit", {
                method: "POST",
                body: {
                  asset_id: asset.id,
                  image_width: 1,
                  image_height: 1,
                  faces: [],
                },
              });
              totalScanned += 1;
            } catch {
              /* swallow */
            }
            console.warn("face scan failed for", asset.id, e);
          }
        }

        // Refresh People list periodically.
        qc.invalidateQueries({ queryKey: ["people"] });
      }

      setState({
        status: "done",
        scanned: totalScanned,
        faces: totalFaces,
        remaining: 0,
        error: null,
      });
      qc.invalidateQueries({ queryKey: ["people"] });
    } catch (e) {
      const err = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setState((s) => ({ ...s, status: "error", error: err }));
    } finally {
      runningRef.current = false;
    }
  }, [qc]);

  return { state, start };
}

/** Auto-start the scanner once on mount (idempotent). */
export function useAutoFaceScan() {
  const { state, start } = useFaceScanner();
  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}