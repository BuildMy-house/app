# Credential Management & Model Ingestion

This document defines how credentials are stored, retrieved, and used across the system. All secrets are stored in **Infisical** and integrated with the **Model Ingestion Service** and **Steward ACS** task coordination.

## Infisical Structure

**Project:** Build My house  
**Project ID:** `8806c2b0-73d2-4bea-8537-5b874c5ff592`  
**Environments:** `dev`, `staging`, `prod`  
**Path:** `/infra`

### R2 Credentials (Cloudflare)

Store these secrets in Infisical `/infra` path:

```yaml
# Infisical Project > Environment > /infra

R2_ACCESS_KEY_ID: 8a9610d85ede50fda6b2d32a0276a413
R2_SECRET_ACCESS_KEY: 92f3e987c635e0752240658da4bbf7d53e53e7e99fbc33d85db34793f0ea930d
R2_ENDPOINT: https://0b3bff6d9384c50ebb0df3ab67e5bc4b.r2.cloudflarestorage.com
R2_BUCKET: buildmyhouse-assets
R2_ACCOUNT_ID: 0b3bff6d9384c50ebb0df3ab67e5bc4b
R2_PUBLIC_URL: https://buildmyhouse-assets.0b3bff6d9384c50ebb0df3ab67e5bc4b.r2.dev
```

## Model Ingestion Service

The `ModelIngestionService` automatically loads R2 credentials from Infisical:

```typescript
import { modelIngestionService } from '@/services/model-ingestion-service'

// Initialize with Infisical config
const creds = await modelIngestionService.fetchCredentialsFromInfisical()
if (creds) {
  console.log('✓ Connected to R2:', creds.R2_BUCKET)
}
```

**Location:** `buildmyhouse/src/services/model-ingestion-service.ts`

## Steward ACS Integration

Model ingestion tasks are tracked in Steward with the following structure:

### Task Type: `model-ingestion`

**Fields:**
- `title` — Model ingestion batch (e.g., "Import 10 SH3D models with textures")
- `scope` — Always limited to 5-20 models per task for manageability
- `status` — `pending` → `processing` → `completed`
- `credentials` — Fetched from Infisical at task start
- `batchSize` — Number of models to process (5-20 recommended)
- `uploadToR2` — Boolean; upload to R2 or local only
- `mergeIntoCatalog` — Boolean; merge results into catalog

**Example task:**
```
Title: Import 10 SH3D models with textures (Living room)
Scope: 10 models
Status: pending
```

### Workflow with Steward

1. **Manager creates task** via `create_work()`:
   ```typescript
   create_work({
     title: 'Import 10 SH3D models (batch 1)',
     claim: true,
     scope: 'model-ingestion',
     detail: '10 Living room models with texture baking',
   })
   ```

2. **Worker claims task** via `claim_work()`:
   ```bash
   npm run import:batch -- --limit 10 --upload
   ```

3. **Service fetches credentials** from Infisical automatically

4. **Worker saves results** via `close_work()`:
   ```typescript
   close_work({
     task_id,
     improvements: 'Added 10 textured models to R2 and catalog',
     learned_for_agents: 'Batch imports work best at 10-model chunks',
   })
   ```

## Using Credentials Programmatically

### Command Line

```bash
# Credentials auto-loaded from Infisical
npm run import:batch -- --limit 10 --upload

# Or set manually for testing
export R2_ACCESS_KEY_ID="..."
export R2_SECRET_ACCESS_KEY="..."
npm run import:batch -- --limit 5 --upload
```

### In Code

```typescript
import { modelIngestionService } from '@/services/model-ingestion-service'

// Auto-load from Infisical
await modelIngestionService.fetchCredentialsFromInfisical()

// Check status
const status = modelIngestionService.getStatus()
console.log('R2 configured:', status.r2Configured)
console.log('Can upload:', status.canUpload)

// Process batch
await modelIngestionService.processBatch({
  limit: 10,
  uploadToR2: true,
  mergeIntoCatalog: true,
})
```

## Adding New Credentials

To add credentials to Infisical:

1. **Via Infisical UI:**
   - Navigate to Project > Environment > /infra path
   - Add secret with key and value
   - Save

2. **Via MCP:**
   ```typescript
   import { mcp__infisical__create-secret } from '@/services'
   
   await create_secret({
     projectId: '8806c2b0-73d2-4bea-8537-5b874c5ff592',
     environmentSlug: 'dev',
     secretPath: '/infra',
     secretName: 'NEW_SECRET',
     secretValue: 'value',
   })
   ```

## Security Notes

- **Never commit secrets** to git — all credentials in Infisical only
- **Environment-specific** — dev uses dev credentials, prod uses prod
- **Token rotation** — If R2 key rotates, update in Infisical immediately
- **Access control** — Only designated users should modify /infra secrets

## Troubleshooting

### "Credentials not found"
1. Check Infisical project ID: `8806c2b0-73d2-4bea-8537-5b874c5ff592`
2. Verify environment: dev/staging/prod
3. Verify path: `/infra`
4. Confirm token: `INFISICAL_TOKEN` in environment

### "R2 upload failed"
1. Verify credentials are current (no rotation pending)
2. Check bucket name matches: `buildmyhouse-assets`
3. Verify endpoint is correct S3-compatible URL
4. Check network connectivity to R2

### "Cannot connect to Infisical"
1. Verify `INFISICAL_TOKEN` is set
2. Check `INFISICAL_API_URL` points to EU: `https://eu.infisical.com/api/v1`
3. Verify token hasn't expired
4. Check firewall/network allows outbound to Infisical

## See Also

- [SH3D Model Import Guide](./SH3D_MODEL_IMPORT.md)
- [Model Ingestion Service](../buildmyhouse/src/services/model-ingestion-service.ts)
- [Steward ACS Coordination](../CLAUDE.md#mandatory-steward-acs-coordination)
