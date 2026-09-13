import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timed } from './telemetry.js';

/**
 * Per-user asset file storage. Each user's GLB/source bytes live under
 * `<root>/<safeUserId>/<assetId>.glb` etc. — never in DB BLOB columns, since
 * assets can reach MAX_IMPORT_BYTES (50MB). The DB stores metadata + paths.
 */
export class AssetStorage {
  constructor(private readonly root: string) {}

  private userDir(userId: string): string {
    return join(this.root, userId);
  }

  private path(userId: string, fileName: string): string {
    return join(this.userDir(userId), fileName);
  }

  save(userId: string, fileName: string, data: Buffer): string {
    return timed('save', () => {
      const dir = this.userDir(userId);
      mkdirSync(dir, { recursive: true });
      const filePath = this.path(userId, fileName);
      writeFileSync(filePath, data);
      return filePath;
    }, { fileSizeKB: data.byteLength / 1024, format: fileName.split('.').pop() });
  }

  read(userId: string, fileName: string): Buffer | undefined {
    return timed('read', () => {
      const filePath = this.path(userId, fileName);
      try {
        return readFileSync(filePath);
      } catch {
        return undefined;
      }
    }, { format: fileName.split('.').pop() });
  }

  remove(userId: string, fileName: string): void {
    timed('remove', () => {
      rmSync(this.path(userId, fileName), { force: true });
    }, { format: fileName.split('.').pop() });
  }
}
