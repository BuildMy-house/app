#!/usr/bin/env node
/**
 * upload-textures.ts — one-time, idempotent upload of the wall/floor
 * textures to R2 under the `materials/` prefix (mirrors the `models/`
 * furniture pipeline). Safe to re-run: every file is PUT again and
 * HEAD-verified against its public URL.
 *
 *   source r2.env && npm run textures:upload
 *
 * Source PNGs live in assets/textures/ (committed). If one is missing,
 * regenerate with `npm run textures:generate`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getR2S3Client, r2PublicUrl, uploadR2Object } from '../src/services/r2-client'
import { WALL_TEXTURES } from '../src/core/home'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEXTURES_DIR = join(ROOT, 'assets', 'textures')
const R2_KEY_PREFIX = 'materials'

const files = [
  ...new Set(
    WALL_TEXTURES.flatMap((t) => [t.file, t.normalFile, t.roughnessFile, t.metalnessFile, t.aoFile]).filter(
      (f): f is string => Boolean(f),
    ),
  ),
]

function fail(message: string): never {
  console.error(`[textures] ERROR: ${message}`)
  process.exit(1)
}

let uploaded = 0
let verified = 0
const s3 = getR2S3Client()

for (const file of files) {
  const localPath = join(TEXTURES_DIR, file)
  if (!existsSync(localPath)) {
    fail(`missing source texture: ${localPath} (run npm run textures:generate)`)
  }
  const key = `${R2_KEY_PREFIX}/${file}`
  const publicUrl = `${r2PublicUrl()}/${key}`
  const buffer = readFileSync(localPath)
  await uploadR2Object(s3, key, buffer, 'image/png')
  uploaded++
  const res = await fetch(publicUrl, { method: 'HEAD' })
  const ok = res.ok && (res.headers.get('content-type') ?? '').includes('image/png')
  if (!ok) fail(`upload verification failed for ${key}: HTTP ${res.status}`)
  verified++
  console.log(`[textures] uploaded + verified ${key} (${buffer.length} bytes)`)
}

console.log(`[textures] done: ${uploaded} uploaded, ${verified} verified (${files.length} files)`)
