import { supabase, SUPABASE_URL } from "@/lib/supabase";
import type { MetadataBatch, ScanRequest, ScanProgress, BatchSummary } from "../../../packages/core/metadata/types";

const FN_BASE = `${SUPABASE_URL}/functions/v1/scans`;

async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = { ...(await authHeader()), ...(init.headers || {}) };
  const res = await fetch(`${FN_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch { /* */ }
    throw new Error(`scans ${path} ${res.status}: ${body?.error?.message ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function startScan(req: ScanRequest): Promise<{ scan: any }> {
  return request("/v1/start", { method: "POST", body: JSON.stringify(req) });
}

export async function sendBatch(scanId: string, batch: MetadataBatch): Promise<{ summary: BatchSummary }> {
  return request(`/v1/${scanId}/batch`, { method: "POST", body: JSON.stringify(batch) });
}

export async function getProgress(scanId: string): Promise<{ progress: ScanProgress }> {
  return request(`/v1/${scanId}/progress`, { method: "GET" });
}

export async function cancelScan(scanId: string): Promise<void> {
  await request(`/v1/${scanId}/cancel`, { method: "POST" });
}

export async function finalizeScan(scanId: string): Promise<void> {
  await request(`/v1/${scanId}/finalize`, { method: "POST" });
}

export async function listErrors(scanId: string): Promise<{ errors: any[] }> {
  return request(`/v1/${scanId}/errors`, { method: "GET" });
}

export async function saveCheckpoint(scanId: string, payload: {
  directoryQueue?: string[];
  batchSequence?: number;
  lastProcessedPath?: string | null;
  currentPhase?: string;
}): Promise<void> {
  await request(`/v1/${scanId}/checkpoint`, { method: "POST", body: JSON.stringify(payload) });
}