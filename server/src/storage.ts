import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Safe identifier token (asset ids, user ids): letters, digits, underscore,
 * hyphen, 1–128 chars. Rejects path separators, `..`, dots, whitespace.
 */
export const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// Stored asset files are always `<safeId>.glb` or `<safeId>.source`.
const SAFE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}\.(?:glb|source)$/;

function assertSafeUserId(userId: string): void {
  if (!SAFE_TOKEN_PATTERN.test(userId)) {
    throw new Error(`AssetStorage: unsafe userId ${JSON.stringify(userId)}`);
  }
}

function assertSafeFileName(fileName: string): void {
  if (!SAFE_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error(`AssetStorage: unsafe fileName ${JSON.stringify(fileName)}`);
  }
}

/**
 * Per-user asset file storage. Each user's GLB/source bytes live under
 * `<root>/<safeUserId>/<assetId>.glb` etc. — never in DB BLOB columns, since
 * assets can reach MAX_IMPORT_BYTES (50MB). The DB stores metadata + paths.
 *
 * Defense in depth: every method independently validates userId/fileName and
 * throws on traversal attempts, so no caller can reintroduce a path-traversal
 * write/read/delete by skipping its own validation (H17).
 */
export class AssetStorage {
  constructor(private readonly root: string) {}

  private userDir(userId: string): string {
    assertSafeUserId(userId);
    return join(this.root, userId);
  }

  private path(userId: string, fileName: string): string {
    assertSafeFileName(fileName);
    return join(this.userDir(userId), fileName);
  }

  save(userId: string, fileName: string, data: Buffer): string {
    // Validate before mkdirSync so a rejected save has zero side effects.
    const filePath = this.path(userId, fileName);
    mkdirSync(join(this.root, userId), { recursive: true });
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
