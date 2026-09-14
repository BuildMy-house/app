/**
 * Fetch R2 credentials from Infisical and export as env vars
 * Usage: tsx scripts/fetch-r2-credentials.ts
 */

import { execSync } from 'node:child_process'

const token = process.env.INFISICAL_TOKEN
const apiUrl = process.env.INFISICAL_API_URL || 'https://eu.infisical.com/api/v1'

if (!token) {
  console.error('INFISICAL_TOKEN not set in environment')
  process.exit(1)
}

const r2Keys = {
  R2_ACCOUNT_ID: 'R2_ACCOUNT_ID',
  R2_ACCESS_KEY_ID: 'R2_ACCESS_KEY_ID',
  R2_SECRET_ACCESS_KEY: 'R2_SECRET_ACCESS_KEY',
  R2_S3_ENDPOINT: 'R2_S3_ENDPOINT',
  R2_BUCKET_NAME: 'R2_BUCKET_NAME',
  R2_PUBLIC_URL: 'R2_PUBLIC_URL',
}

async function fetchCredentials() {
  console.log('Fetching R2 credentials from Infisical...\n')

  const credentials: Record<string, string> = {}

  for (const [envKey, secretName] of Object.entries(r2Keys)) {
    try {
      // Use infisical CLI if available
      const cmd = `infisical secrets get ${secretName} --plain`
      const value = execSync(cmd, { encoding: 'utf-8' }).trim()
      if (value) {
        credentials[envKey] = value
        console.log(`✓ ${envKey}`)
      }
    } catch (err) {
      console.log(`✗ ${envKey} (infisical CLI not available)`)
    }
  }

  if (Object.keys(credentials).length === 0) {
    console.error('Failed to fetch any R2 credentials from Infisical')
    process.exit(1)
  }

  // Export as shell commands
  console.log('\n# Export these to use with npm run import:batch:\n')
  for (const [key, value] of Object.entries(credentials)) {
    console.log(`export ${key}="${value}"`)
  }

  console.log('\n# Or add to .env.local and source it')
  return credentials
}

fetchCredentials().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
