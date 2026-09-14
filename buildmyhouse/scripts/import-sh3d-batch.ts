/**
 * import-sh3d-batch.ts — Process a small batch of SH3D models for testing
 *
 * Simpler workflow for incremental model processing:
 *   npm run import:batch -- --limit 5                     # Convert 5 models locally
 *   npm run import:batch -- --limit 5 --category Living   # Filter by category
 *   npm run import:batch -- --upload --limit 5            # Convert + upload to R2
 *
 * Set R2 env vars to enable upload:
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET_NAME / R2_PUBLIC_URL
 */

import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const limit = Math.min(Number(args[args.indexOf('--limit') + 1] ?? 10), 50)
const category = args[args.indexOf('--category') + 1] ?? null
const shouldUpload = args.includes('--upload')
const skipUpload = args.includes('--skip-upload')

let command = `tsx scripts/import-sh3d-library.ts --limit ${limit}`

if (category) {
  command += ` --category ${category}`
}

if (shouldUpload && !skipUpload) {
  // Don't pass --skip-upload so it will upload
} else {
  command += ' --skip-upload'
}

if (args.includes('--merge-catalog')) {
  command += ' --merge-catalog'
}

console.log(`\n╔════════════════════════════════════════════════════════════╗`)
console.log(`║  SH3D Model Batch Import (Incremental)                    ║`)
console.log(`╚════════════════════════════════════════════════════════════╝\n`)
console.log(`Processing: ${limit} models`)
if (category) console.log(`Category: ${category}`)
console.log(`Upload: ${shouldUpload && !skipUpload ? 'Yes (to R2)' : 'No (local only)'}`)
console.log(`\nRunning: ${command}\n`)

try {
  execSync(command, { stdio: 'inherit' })
  console.log(`\n✓ Batch complete`)
  console.log(`\nNext steps:`)
  console.log(`  1. Review models: npm run ingest:list`)
  console.log(`  2. Update catalog: npm run import:batch -- --merge-catalog`)
  console.log(`  3. Process more: npm run import:batch -- --limit 10`)
} catch (err) {
  console.error(`\n✗ Batch failed`)
  process.exit(1)
}
