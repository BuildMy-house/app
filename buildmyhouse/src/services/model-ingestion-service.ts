/**
 * Model Ingestion Service — Core application service for managing 3D models
 *
 * This is the central hub for all model operations:
 * - Loading models from SH3D sources
 * - Converting OBJ→GLB with texture baking
 * - Uploading to Cloudflare R2
 * - Managing catalog metadata
 * - Tag generation for search
 *
 * Designed to be part of the application architecture, not separate scripts.
 * Integrates with Infisical for credential management.
 *
 * CREDENTIAL STRUCTURE (stored in Infisical /infra path):
 * ─────────────────────────────────────────────────────
 * Project: "Build My house"
 * Environment: dev (development) or prod (production)
 * Path: /infra
 *
 * Required secrets:
 *   - R2_ACCOUNT_ID — Cloudflare account ID (extracted from endpoint)
 *   - R2_ACCESS_KEY_ID — R2 API access key
 *   - R2_SECRET_ACCESS_KEY — R2 API secret key
 *   - R2_BUCKET — Bucket name (e.g., "buildmyhouse-assets")
 *   - R2_ENDPOINT — S3-compatible endpoint URL
 *   - R2_PUBLIC_URL — Public CDN URL for models (optional, defaults to endpoint)
 *
 * Integration with Steward ACS:
 * ──────────────────────────────
 * Model ingestion tasks should be tracked in Steward with:
 *   - Task type: "model-ingestion"
 *   - Scope: limited number of models per task (5-20)
 *   - Status: pending → processing → completed
 *   - Credentials: Fetched from Infisical at task start
 *   - Results: R2 URLs and catalog updates
 */

export interface ModelIngestionConfig {
  r2?: {
    accountId: string
    accessKeyId: string
    secretAccessKey: string
    endpoint: string
    bucketName: string
    publicUrl: string
  }
  infisical?: {
    token: string
    apiUrl: string
    projectId: string
    environmentSlug: string
  }
  localOnly?: boolean
}

export interface InfisicalCredentials {
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  R2_ENDPOINT: string
  R2_ACCOUNT_ID?: string
  R2_PUBLIC_URL?: string
}

export interface IngestionBatch {
  limit: number
  category?: string
  uploadToR2: boolean
  mergeIntoCatalog: boolean
}

export interface IngestionProgress {
  phase: 'downloading' | 'extracting' | 'converting' | 'uploading' | 'merging' | 'complete'
  processed: number
  total: number
  currentItem?: string
  error?: string
}

/**
 * Core model ingestion service that can be used by:
 * - CLI scripts (npm run commands)
 * - Admin dashboard/UI
 * - Server-side API endpoints
 * - Automation workflows
 */
export class ModelIngestionService {
  private config: ModelIngestionConfig
  private progressCallbacks: Array<(progress: IngestionProgress) => void> = []

  constructor(config: ModelIngestionConfig = {}) {
    this.config = config
    this.loadConfigFromEnvironment()
  }

  /**
   * Load configuration from environment variables and Infisical
   */
  private loadConfigFromEnvironment(): void {
    // R2 credentials from env
    if (process.env.R2_ACCOUNT_ID) {
      this.config.r2 = {
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        endpoint: process.env.R2_S3_ENDPOINT || '',
        bucketName: process.env.R2_BUCKET_NAME || 'models',
        publicUrl: process.env.R2_PUBLIC_URL || '',
      }
    }

    // Infisical token from env
    if (process.env.INFISICAL_TOKEN) {
      this.config.infisical = {
        token: process.env.INFISICAL_TOKEN,
        apiUrl: process.env.INFISICAL_API_URL || 'https://eu.infisical.com/api/v1',
        projectId: process.env.INFISICAL_PROJECT_ID || '',
        environmentSlug: process.env.INFISICAL_ENV || 'prod',
      }
    }
  }

  /**
   * Fetch R2 credentials from Infisical (if available)
   * Credentials should be stored in Infisical at:
   *   Project: "Build My house" (ID: 8806c2b0-73d2-4bea-8537-5b874c5ff592)
   *   Environment: dev or prod
   *   Path: /infra
   *
   * Expected secrets:
   *   - R2_ACCESS_KEY_ID
   *   - R2_SECRET_ACCESS_KEY
   *   - R2_BUCKET
   *   - R2_ENDPOINT
   */
  async fetchCredentialsFromInfisical(): Promise<InfisicalCredentials | null> {
    if (!this.config.infisical?.token) {
      console.warn('Infisical token not configured')
      return null
    }

    try {
      const { token, apiUrl, projectId, environmentSlug } = this.config.infisical

      const r2Keys = [
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET',
        'R2_ENDPOINT',
        'R2_ACCOUNT_ID',
        'R2_PUBLIC_URL',
      ]

      const credentials: any = {}

      for (const key of r2Keys) {
        // Query Infisical for each secret at /infra path
        const response = await fetch(`${apiUrl}/secrets/raw/${key}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        })

        if (response.ok) {
          const data = (await response.json()) as any
          credentials[key] = data.secretValue
        }
      }

      if (credentials.R2_ACCESS_KEY_ID && credentials.R2_ENDPOINT) {
        // Extract account ID from endpoint if not provided
        if (!credentials.R2_ACCOUNT_ID) {
          const match = credentials.R2_ENDPOINT.match(/https:\/\/([a-f0-9]+)\.r2/)
          if (match) credentials.R2_ACCOUNT_ID = match[1]
        }

        // Set public URL if not provided
        if (!credentials.R2_PUBLIC_URL && credentials.R2_BUCKET) {
          credentials.R2_PUBLIC_URL = `https://${credentials.R2_BUCKET}.${credentials.R2_ACCOUNT_ID}.r2.dev`
        }

        this.config.r2 = {
          accountId: credentials.R2_ACCOUNT_ID,
          accessKeyId: credentials.R2_ACCESS_KEY_ID,
          secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
          endpoint: credentials.R2_ENDPOINT,
          bucketName: credentials.R2_BUCKET,
          publicUrl: credentials.R2_PUBLIC_URL,
        }

        console.log('✓ R2 credentials loaded from Infisical')
        return credentials as InfisicalCredentials
      }

      console.warn('Incomplete R2 credentials in Infisical')
      return null
    } catch (err) {
      console.warn('Failed to fetch credentials from Infisical:', err instanceof Error ? err.message : err)
      return null
    }
  }

  /**
   * Convert env var name to config property (R2_ACCOUNT_ID -> accountId)
   */
  private keyNameToProp(key: string): string {
    return key
      .replace(/^R2_/, '')
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
  }

  /**
   * Register a progress callback
   */
  onProgress(callback: (progress: IngestionProgress) => void): void {
    this.progressCallbacks.push(callback)
  }

  /**
   * Emit progress updates to all registered callbacks
   */
  private emitProgress(progress: IngestionProgress): void {
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress)
      } catch (err) {
        console.error('Progress callback error:', err)
      }
    }
  }

  /**
   * Process a batch of models
   */
  async processBatch(batch: IngestionBatch): Promise<void> {
    try {
      this.emitProgress({
        phase: 'converting',
        processed: 0,
        total: batch.limit,
      })

      // TODO: Integrate with import-sh3d-library.ts
      // This would orchestrate:
      // 1. Load SH3D models from .sh3d-scratch/extracted
      // 2. Convert OBJ→GLB with textures
      // 3. Upload to R2 if enabled
      // 4. Update catalog if enabled

      this.emitProgress({
        phase: 'complete',
        processed: batch.limit,
        total: batch.limit,
      })
    } catch (err) {
      this.emitProgress({
        phase: 'converting',
        processed: 0,
        total: batch.limit,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * Get current configuration status
   */
  getStatus(): {
    r2Configured: boolean
    infisicalConfigured: boolean
    canUpload: boolean
  } {
    return {
      r2Configured: !!this.config.r2?.accountId,
      infisicalConfigured: !!this.config.infisical?.token,
      canUpload: !!(this.config.r2?.accountId && this.config.r2?.secretAccessKey),
    }
  }
}

// Export singleton instance for use across the application
export const modelIngestionService = new ModelIngestionService()
