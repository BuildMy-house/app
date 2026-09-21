/*
 * Shared R2 (S3-compatible) client + upload primitive.
 *
 * The single upload code path for this repo: models (asset-ingestion-service)
 * and materials/textures (scripts/upload-textures) both go through
 * uploadR2Object(). Credentials come from env: R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET_NAME. The public base URL
 * for uploaded objects is R2_PUBLIC_URL (falls back to the production bucket).
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const R2_PUBLIC_URL_FALLBACK = 'https://assets.buildmy.house'

/** Public base URL serving uploaded R2 objects. */
export function r2PublicUrl(): string {
  return process.env.R2_PUBLIC_URL ?? R2_PUBLIC_URL_FALLBACK
}

/** S3 client pointed at the R2 S3-compatible endpoint. Credentials from env. */
export function getR2S3Client(): S3Client {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT } = process.env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT) {
    throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT must be set in env')
  }
  return new S3Client({
    region: 'auto',
    endpoint: R2_S3_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
}

/** Upload one object to R2. The single upload primitive — use this, don't PUT directly. */
export async function uploadR2Object(
  s3: S3Client,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) throw new Error('R2_BUCKET_NAME must be set in env')
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Content-addressed by slug, never mutated in place — cache forever.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
}
