/**
 * models-upload.ts — Shared types and client-side helpers for model uploads.
 *
 * Server handles the heavy lifting (validation, normalization, R2 upload).
 * This module provides:
 *  - Shared TypeScript types
 *  - Client-side pre-validation before sending to server
 *  - Upload orchestration (wraps fetch call to POST /api/models/upload)
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ModelFormat = 'glb' | 'gltf' | 'obj';

export interface ModelUploadMetadata {
  name: string;
  category:
    | 'Living'
    | 'Bedroom'
    | 'Kitchen'
    | 'Bathroom'
    | 'Dining'
    | 'Doors'
    | 'Windows'
    | 'Office'
    | 'Outdoor'
    | 'Other';
  width?: number;
  depth?: number;
  height?: number;
  color?: number;
}

export interface ModelUploadResult {
  catalogId: string;
  name: string;
  category: string;
  modelPath: string;
  modelUrl?: string;
  thumbnailPath: string | null;
  thumbnailUrl?: string | null;
  width: number;
  depth: number;
  height: number;
  color: number | null;
  sizeBytes: number;
  createdAt: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Client-side pre-validation                                         */
/* ------------------------------------------------------------------ */

const GLB_MAGIC = 0x46546c67;
const MAX_BYTES = 50 * 1024 * 1024;
const MIN_BYTES = 1024;
const ALLOWED_EXTS: ModelFormat[] = ['glb', 'gltf', 'obj'];

export function getFileExtension(filename: string): ModelFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return (ALLOWED_EXTS as string[]).includes(ext) ? (ext as ModelFormat) : null;
}

/**
 * Pre-validate a File before uploading.
 * Catches obvious errors client-side to avoid a round-trip.
 */
export function validateBeforeUpload(file: File, metadata: ModelUploadMetadata): ValidationError[] {
  const errors: ValidationError[] = [];

  const ext = getFileExtension(file.name);
  if (!ext) {
    errors.push({ field: 'file', message: 'Only GLB, GLTF, and OBJ formats are supported' });
  }

  if (file.size > MAX_BYTES) {
    errors.push({
      field: 'file',
      message: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum 50 MB.`,
    });
  }

  if (file.size < MIN_BYTES) {
    errors.push({ field: 'file', message: 'File too small — ensure it contains valid 3D model data' });
  }

  if (!metadata.name?.trim()) {
    errors.push({ field: 'name', message: 'Model name is required' });
  }

  if (!metadata.category) {
    errors.push({ field: 'category', message: 'Category is required' });
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/*  Upload to server                                                   */
/* ------------------------------------------------------------------ */

/**
 * Upload a model file to the server via multipart/form-data.
 * Server validates, normalizes geometry (OBJ→GLB), uploads to R2, and
 * returns the catalog entry.
 */
export async function uploadModelToServer(
  file: File,
  metadata: ModelUploadMetadata,
): Promise<ModelUploadResult> {
  const preErrors = validateBeforeUpload(file, metadata);
  if (preErrors.length > 0) {
    throw new Error(preErrors.map((e) => e.message).join('; '));
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('name', metadata.name.trim());
  formData.append('category', metadata.category);
  if (metadata.width != null) formData.append('width', String(metadata.width));
  if (metadata.depth != null) formData.append('depth', String(metadata.depth));
  if (metadata.height != null) formData.append('height', String(metadata.height));
  if (metadata.color != null) formData.append('color', String(metadata.color));

  const res = await fetch('/api/models/upload', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `upload failed (${res.status})`);
  }

  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Catalog helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Generate catalog ID from uploaded filename.
 * "my-chair.glb" → "user#my-chair"
 */
export function generateCatalogId(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `user#${name}`;
}

/**
 * Generate model output path for R2 storage.
 * "user#my-chair" → "models/user-my-chair.glb"
 */
export function generateModelPath(catalogId: string, ext: string = '.glb'): string {
  const name = catalogId.replace(/^user#/, 'user-');
  return `models/${name}${ext}`;
}
