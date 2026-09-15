#!/usr/bin/env node
/**
 * patch-r2-cache-headers.ts — one-time-but-idempotent maintenance script.
 *
 * Older catalog objects in R2 were uploaded before uploadR2Object() set
 * Cache-Control, so browsers/CDN edges revalidate on every load. This script
 * adds `Cache-Control: public, max-age=31536000, immutable` to every existing
 * object under the models/ and thumbs/ prefixes WITHOUT re-uploading bodies,
 * via self-CopyObject with MetadataDirective: REPLACE (metadata-only copy).
 *
 * Idempotent: objects already carrying the exact target header are skipped,
 * so re-running is a no-op.
 *
 *   npm run patch-r2-cache-headers
 *
 * Requires R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT /
 * R2_BUCKET_NAME in env; exits 0 with a warning if missing.
 */
import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getR2S3Client } from '../src/services/r2-client.js'

// ponytail: keep in sync with the CacheControl in uploadR2Object() (r2-client.ts)
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const PREFIXES = ['models/', 'thumbs/']

async function main(): Promise<void> {
  const {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_S3_ENDPOINT,
    R2_BUCKET_NAME: bucket,
  } = process.env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT || !bucket) {
    console.warn(
      '[patch] R2 credentials not set (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET_NAME) — skipping Cache-Control patch. Run this script manually with R2 credentials configured.',
    )
    return
  }
  const s3 = getR2S3Client()
  let patched = 0
  let alreadyCorrect = 0
  let failed = 0
  let done = 0

  for (const prefix of PREFIXES) {
    let continuationToken: string | undefined
    do {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      )
      // ponytail: sequential loop, ~210 objects runs once — bounded pool only if this ever grows
      for (const obj of list.Contents ?? []) {
        const key = obj.Key
        if (!key) continue
        done++
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
          if (head.CacheControl === CACHE_CONTROL) {
            alreadyCorrect++
            continue
          }
          await s3.send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: key,
              CopySource: `/${bucket}/${key}`,
              MetadataDirective: 'REPLACE',
              CacheControl: CACHE_CONTROL,
              ContentType: head.ContentType, // REPLACE drops metadata; resupply content-type
            }),
          )
          patched++
          console.log(`[patch] ${done} done (${patched} patched) — ${key}`)
        } catch (err) {
          failed++
          console.error(`[patch] FAILED ${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (continuationToken)
  }

  console.log(`[patch] done: ${done} scanned, ${patched} patched, ${alreadyCorrect} already correct, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`[patch] ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
