#!/usr/bin/env node
/**
 * import-sh3d-library.ts — MAT-T8 CLI wrapper around AssetIngestionService
 * (src/services/asset-ingestion-service.ts), which owns the actual pipeline:
 * SH3D properties parsing, OBJ->GLB conversion, R2 upload+verify, checkpoint,
 * catalog merge and (via processBatch) thumbnail generation.
 *
 * Requires the 3DModels-*.zip releases pre-extracted to
 *   <scratchRoot>/extracted/sh3f/<sub>/PluginFurnitureCatalog.properties
 * (scratchRoot = $SH3D_SCRATCH_ROOT or <repoRoot>/.sh3d-scratch).
 *
 *   tsx scripts/import-sh3d-library.ts                 # full pipeline: convert + upload + verify + catalog + thumbs
 *   tsx scripts/import-sh3d-library.ts --skip-upload   # convert only
 *   tsx scripts/import-sh3d-library.ts --upload-only   # upload+verify already-converted GLBs
 *   tsx scripts/import-sh3d-library.ts --merge-catalog # merge completed entries into assets/catalog/catalog.json
 *   tsx scripts/import-sh3d-library.ts --limit=5       # process at most 5 uncompleted items
 *
 * R2 credentials come from env (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
 * R2_S3_ENDPOINT/R2_BUCKET_NAME/R2_PUBLIC_URL) — never hardcoded.
 */
import { AssetIngestionService } from '../src/services/asset-ingestion-service.js'

async function main(): Promise<void> {
  const limit = Math.max(0, Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0))
  const service = new AssetIngestionService()
  if (process.argv.includes('--merge-catalog')) {
    service.mergeCatalog()
    return
  }
  const options = { limit }
  if (process.argv.includes('--upload-only')) await service.uploadBatch(options)
  else if (process.argv.includes('--skip-upload')) await service.convertBatch(options)
  else await service.processBatch(options)
}

void main()
