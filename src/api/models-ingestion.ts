/**
 * models-ingestion.ts — Client-side API module for user model uploads.
 *
 * Re-exports shared types/helpers from src/lib/models-upload.ts.
 * This file is the public client-side API surface for the upload pipeline.
 */

export {
  type ModelFormat,
  type ModelUploadMetadata,
  type ModelUploadResult,
  type ValidationError,
  getFileExtension,
  validateBeforeUpload,
  uploadModelToServer,
  generateCatalogId,
  generateModelPath,
} from '../lib/models-upload.js';

// Re-export uploadModelToServer as the legacy name used by callers
export { uploadModelToServer as uploadModel } from '../lib/models-upload.js';
