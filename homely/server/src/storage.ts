import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    const dir = this.userDir(userId);
    mkdirSync(dir, { recursive: true });
    const filePath = this.path(userId, fileName);
    writeFileSync(filePath, data);
    return filePath;
  }

  read(userId: string, fileName: string): Buffer | undefined {
    const filePath = this.path(userId, fileName);
    try {
      return readFileSync(filePath);
    } catch {
      return undefined;
    }
  }

  remove(userId: string, fileName: string): void {
    rmSync(this.path(userId, fileName), { force: true });
  }
}
