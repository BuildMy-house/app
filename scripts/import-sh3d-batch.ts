/**
 * import-sh3d-batch.ts — Process a small batch of SH3D models for testing
 *
 * Simpler workflow for incremental model processing (runs the
 * AssetIngestionService pipeline in-process):
 *   npm run import:batch -- --limit 5                     # Convert 5 models locally
 *   npm run import:batch -- --limit 5 --category Living   # Filter by category
 *   npm run import:batch -- --upload --limit 5            # Convert + upload to R2
 *   npm run import:batch -- --merge-catalog               # Merge verified entries into the catalog
 *
 * R2 credentials: read from env (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
 * R2_S3_ENDPOINT / R2_BUCKET_NAME / R2_PUBLIC_URL) when set; otherwise
 * fetched from Infisical (requires INFISICAL_TOKEN).
 */

import { AssetIngestionService } from '../src/services/asset-ingestion-service.js'

const args = process.argv.slice(2)
const parsedLimit = Number(args[args.indexOf('--limit') + 1] ?? 10)
const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10, 50)
const categoryIdx = args.indexOf('--category')
const category = categoryIdx !== -1 ? args[categoryIdx + 1] ?? null : null
const shouldUpload = args.includes('--upload')
const skipUpload = args.includes('--skip-upload')
const upload = shouldUpload && !skipUpload

console.log(`\n╔════════════════════════════════════════════════════════════╗`)
console.log(`║  SH3D Model Batch Import (Incremental)                    ║`)
console.log(`╚════════════════════════════════════════════════════════════╝\n`)
console.log(`Processing: ${limit} models`)
if (category) console.log(`Category: ${category}`)
console.log(`Upload: ${upload ? 'Yes (to R2)' : 'No (local only)'}\n`)

const service = new AssetIngestionService()

try {
  if (args.includes('--merge-catalog')) {
    service.mergeCatalog()
  } else {
    // Manual R2_* env exports win; only hit Infisical when they're absent.
    if (upload && !process.env.R2_ACCESS_KEY_ID) {
      const creds = await service.fetchCredentialsFromInfisical()
      if (!creds) console.warn('No R2 credentials from Infisical; set R2_* env vars to enable upload')
    }

    let lastPhase = ''
    service.onProgress((p) => {
      if (p.phase !== lastPhase) {
        lastPhase = p.phase
        console.log(`[import] phase: ${p.phase} (${p.processed}/${p.total})`)
      }
    })

    const result = await service.processBatch({
      limit,
      category: category ?? undefined,
      uploadToR2: upload,
      mergeIntoCatalog: false,
    })
    console.log(`[import] batch: converted=${result.converted} uploaded=${result.uploaded} errors=${result.errors.length}`)
  }

  console.log(`\n✓ Batch complete`)
  console.log(`\nNext steps:`)
  console.log(`  1. Review models: npm run ingest:list`)
  console.log(`  2. Update catalog: npm run import:batch -- --merge-catalog`)
  console.log(`  3. Process more: npm run import:batch -- --limit 10`)
} catch (err) {
  console.error(`\n✗ Batch failed`, err instanceof Error ? err.message : err)
  process.exit(1)
}
