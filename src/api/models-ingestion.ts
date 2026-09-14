/**
 * models-ingestion.ts — Accept, validate, and process user model uploads
 *
 * Pipeline:
 * 1. Receive GLB/OBJ + metadata (name, category)
 * 2. Validate: file size, geometry, materials
 * 3. Process: normalize scale, embed textures if needed
 * 4. Generate: thumbnail preview
 * 5. Upload: GLB → R2, thumbnail → R2
 * 6. Register: add to catalog.json (local or via admin API)
 */

import { extname } from 'node:path'

export interface ModelUploadRequest {
  /** Original filename (e.g., "my-chair.glb") */
  filename: string
  /** Binary model data */
  fileBuffer: Buffer
  /** Catalog metadata */
  metadata: {
    name: string
    category:
      | 'Living'
      | 'Bedroom'
      | 'Kitchen'
      | 'Bathroom'
      | 'Doors'
      | 'Windows'
      | 'Office'
      | 'Other'
    width?: number
    depth?: number
    height?: number
    color?: number
  }
}

export interface UploadValidationError {
  field: string
  message: string
}

/**
 * Validate uploaded model file
 */
export function validateModelUpload(req: ModelUploadRequest): UploadValidationError[] {
  const errors: UploadValidationError[] = []

  // Check file format
  const ext = extname(req.filename).toLowerCase()
  if (!['.glb', '.gltf', '.obj'].includes(ext)) {
    errors.push({
      field: 'filename',
      message: 'Only GLB, GLTF, and OBJ formats are supported',
    })
  }

  // Check file size (limit 50MB per model)
  const maxSize = 50 * 1024 * 1024
  if (req.fileBuffer.length > maxSize) {
    errors.push({
      field: 'fileBuffer',
      message: `File too large (${(req.fileBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum 50MB.`,
    })
  }

  // Check file size minimum (at least 1KB of data)
  if (req.fileBuffer.length < 1024) {
    errors.push({
      field: 'fileBuffer',
      message: 'File too small. Ensure it contains valid 3D model data.',
    })
  }

  // Metadata validation
  const { metadata } = req
  if (!metadata.name || metadata.name.trim().length === 0) {
    errors.push({
      field: 'metadata.name',
      message: 'Model name is required',
    })
  }

  if (!metadata.category) {
    errors.push({
      field: 'metadata.category',
      message: 'Category is required',
    })
  }

  // Dimensions should be reasonable (1cm to 500cm)
  if (metadata.width && (metadata.width < 1 || metadata.width > 500)) {
    errors.push({
      field: 'metadata.width',
      message: 'Width must be between 1 and 500 cm',
    })
  }
  if (metadata.depth && (metadata.depth < 1 || metadata.depth > 500)) {
    errors.push({
      field: 'metadata.depth',
      message: 'Depth must be between 1 and 500 cm',
    })
  }
  if (metadata.height && (metadata.height < 1 || metadata.height > 500)) {
    errors.push({
      field: 'metadata.height',
      message: 'Height must be between 1 and 500 cm',
    })
  }

  return errors
}

/**
 * Generate catalog ID from uploaded filename
 * "my-chair.glb" → "user#my-chair"
 */
export function generateCatalogId(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `user#${name}`
}

/**
 * Generate model output filename for R2
 * "user#my-chair" → "user-my-chair.glb"
 */
export function generateModelPath(catalogId: string, ext: string = '.glb'): string {
  const name = catalogId.replace(/^user#/, 'user-')
  return `models/${name}${ext}`
}

/**
 * Full upload pipeline:
 * 1. Validate request
 * 2. Process model (normalize, embed textures)
 * 3. Generate thumbnail
 * 4. Upload to R2
 * 5. Register in catalog
 */
export async function processModelUpload(
  req: ModelUploadRequest,
): Promise<{
  catalogId: string
  modelPath: string
  thumbnailPath: string
  metadata: ModelUploadRequest['metadata']
}> {
  // Validate
  const errors = validateModelUpload(req)
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.map(e => e.message).join(', ')}`)
  }

  const catalogId = generateCatalogId(req.filename)
  const modelPath = generateModelPath(catalogId)
  const thumbnailPath = generateModelPath(catalogId, '.webp')

  // TODO: Implement these steps:
  // 1. Parse model (GLTFLoader for GLB, OBJLoader for OBJ)
  // 2. Validate geometry (vertex count, normals)
  // 3. Normalize scale to catalog dimensions
  // 4. Generate thumbnail using thumbnail-generator
  // 5. Upload both to R2
  // 6. Return catalog entry data

  return {
    catalogId,
    modelPath,
    thumbnailPath,
    metadata: req.metadata,
  }
}

export default processModelUpload
