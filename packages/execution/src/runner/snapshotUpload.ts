/** Per-session chunk staging; dispose also removes interrupted uploads. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SNAPSHOT_CHUNK_BYTES = 2 * 1024 * 1024;
export function createSnapshotUploads() {
  const uploads = new Map<
    string,
    { path: string; received: number; total: number }
  >();
  let directory: string | null = null;
  return {
    put(input: {
      commit: string;
      offset: number;
      total: number;
      data: string;
    }) {
      const previous = uploads.get(input.commit);
      const fail = (error: string) => ({
        ok: false,
        error,
        received: previous?.received ?? 0,
      });
      if (!/^[0-9a-f]{40}$/.test(input.commit))
        return fail("invalid snapshot commit");
      if (
        !Number.isSafeInteger(input.total) ||
        input.total <= 0 ||
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0
      )
        return fail("invalid upload size or offset");
      if (input.data.length > Math.ceil(SNAPSHOT_CHUNK_BYTES / 3) * 4)
        return fail("snapshot chunk too large");
      const chunk = Buffer.from(input.data, "base64");
      if (
        chunk.toString("base64") !== input.data ||
        chunk.length === 0 ||
        chunk.length > SNAPSHOT_CHUNK_BYTES
      )
        return fail("invalid snapshot chunk");
      if (
        input.offset !== (previous?.received ?? 0) ||
        (previous !== undefined && input.total !== previous.total) ||
        input.offset + chunk.length > input.total
      )
        return fail("out-of-order snapshot chunk");
      try {
        if (directory === null) {
          // Normal disposal removes these immediately. SIGKILL cannot run a
          // finalizer, so staging belongs to the OS temporary-file lifecycle,
          // like runner workspaces, rather than a permanent object cache.
          const root = join(tmpdir(), "odu", "snapshots");
          mkdirSync(root, { recursive: true });
          directory = mkdtempSync(join(root, `upload-${process.pid}-`));
        }
        const upload = previous ?? {
          path: join(directory, `${input.commit}.bundle`),
          received: 0,
          total: input.total,
        };
        appendFileSync(upload.path, chunk);
        upload.received += chunk.length;
        uploads.set(input.commit, upload);
        return { ok: true, error: null, received: upload.received };
      } catch (error) {
        return fail(String(error));
      }
    },
    path(commit: string): string | null {
      const upload = uploads.get(commit);
      return upload !== undefined && upload.received === upload.total
        ? upload.path
        : null;
    },
    dispose(): void {
      if (directory !== null)
        rmSync(directory, { recursive: true, force: true });
      directory = null;
      uploads.clear();
    },
  };
}
