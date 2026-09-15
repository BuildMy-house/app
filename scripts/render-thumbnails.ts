#!/usr/bin/env node
/**
 * render-thumbnails.ts — MAT-T9 CLI wrapper around
 * AssetIngestionService.renderCatalogThumbnails() (same shared renderer the
 * ingestion pipeline uses for new batches). Backfills/regenerates thumbnails
 * for the WHOLE catalog at build time — useful after manual catalog edits.
 *
 *   npm run thumbnails          # render assets/thumbs/<modelPath>.webp per item
 *
 * For every catalog.json item with a modelPath (a local GLB under assets/, or
 * an external R2 URL whose thumbnail uploads to thumbs/ in the same bucket),
 * renders the model with headless Chromium (Playwright) using the same
 * orthographic 3/4-view framing as the runtime fallback in
 * src/ui/model-thumbnail.ts. Thumbnails for external models upload to R2 at
 * thumbs/<slug>.webp; local ones are written under assets/thumbs/ (mirrored
 * to public/ by `npm run assets` sync).
 *
 * Individual model failures are logged and skipped (the runtime fallback
 * covers them); the script only fails hard if the browser cannot run at all.
 */
import { AssetIngestionService } from '../src/services/asset-ingestion-service.js'

async function main(): Promise<void> {
  const service = new AssetIngestionService()
  const { written, total } = await service.renderCatalogThumbnails()
  if (written === 0 && total > 0) {
    console.error('[thumbs] ERROR: no thumbnails written — browser/renderer unavailable?')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`[thumbs] ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
