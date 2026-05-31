/**
 * Iterative BFS traversal over the File System Access API.
 * Skips ignored directories, respects depth limits, never follows symlinks
 * (FS Access doesn't expose them anyway).
 */
import { IGNORED_DIRS } from "./classifier";

export interface DiscoveredFile {
  handle: FileSystemFileHandle;
  file: File;
  relativePath: string;
  folderDepth: number;
}

export async function* walk(
  root: FileSystemDirectoryHandle,
  opts: { maxDepth?: number | null; includeHidden?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<DiscoveredFile> {
  const queue: Array<{ dir: FileSystemDirectoryHandle; path: string; depth: number }> = [
    { dir: root, path: "", depth: 0 },
  ];
  while (queue.length) {
    if (opts.signal?.aborted) return;
    const { dir, path, depth } = queue.shift()!;
    if (opts.maxDepth != null && depth > opts.maxDepth) continue;
    try {
      // @ts-expect-error — values() exists on FileSystemDirectoryHandle in modern browsers
      for await (const entry of dir.values()) {
        if (opts.signal?.aborted) return;
        const name = entry.name as string;
        if (!opts.includeHidden && name.startsWith(".")) continue;
        if (entry.kind === "directory") {
          if (IGNORED_DIRS.has(name)) continue;
          queue.push({
            dir: entry as FileSystemDirectoryHandle,
            path: path ? `${path}/${name}` : name,
            depth: depth + 1,
          });
        } else if (entry.kind === "file") {
          const fh = entry as FileSystemFileHandle;
          try {
            const file = await fh.getFile();
            yield {
              handle: fh,
              file,
              relativePath: path ? `${path}/${name}` : name,
              folderDepth: depth,
            };
          } catch {
            // permission_denied / unreadable — caller records via errors array
            continue;
          }
        }
      }
    } catch {
      // directory unreadable; continue
      continue;
    }
  }
}