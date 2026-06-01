export function encodeCursor(obj: Record<string, unknown>): string {
  return btoa(JSON.stringify(obj));
}
export function decodeCursor<T = Record<string, unknown>>(s: string | undefined | null): T | null {
  if (!s) return null;
  try { return JSON.parse(atob(s)) as T; } catch { return null; }
}
