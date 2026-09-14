import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import Busboy from 'busboy';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import type { DbAdapter } from './db.js';
import { MODEL_UPLOAD_RATE_LIMIT, makeUserRateLimiter } from './rateLimit.js';

const GLB_MAGIC = 0x46546c67;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MIN_MODEL_BYTES = 1024;

const VALID_CATEGORIES = [
  'Living', 'Bedroom', 'Kitchen', 'Bathroom', 'Dining',
  'Doors', 'Windows', 'Office', 'Outdoor', 'Other',
] as const;

const VALID_EXTENSIONS = ['.glb', '.gltf', '.obj'];

/* ------------------------------------------------------------------ */
/*  R2 client                                                          */
/* ------------------------------------------------------------------ */

function getS3Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Format-specific validation                                         */
/* ------------------------------------------------------------------ */

function validateModelFormat(buffer: Buffer, ext: string): string | null {
  if (buffer.byteLength < MIN_MODEL_BYTES) {
    return 'model file is too small — ensure it contains valid 3D data';
  }
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    return `model is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB`;
  }

  if (ext === '.glb') {
    if (buffer.byteLength < 12) return 'GLB file is too small';
    if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
      return 'not a valid GLB file — missing glTF magic number';
    }
    return null;
  }

  if (ext === '.gltf') {
    try {
      const text = buffer.toString('utf8');
      const json = JSON.parse(text);
      if (!json.asset || !json.asset.version) {
        return 'not a valid glTF file — missing asset.version';
      }
    } catch {
      return 'not a valid glTF file — invalid JSON';
    }
    return null;
  }

  if (ext === '.obj') {
    const head = buffer.toString('utf8', 0, Math.min(4096, buffer.byteLength));
    const hasGeom = /^([vvnslf]\s|o\s|g\s|usemtl\s|mtllib\s)/m.test(head);
    if (!hasGeom) {
      return 'not a valid OBJ file — no geometry data found';
    }
    return null;
  }

  return `unsupported format ${ext}`;
}

/* ------------------------------------------------------------------ */
/*  Geometry normalization (OBJ → GLB)                                 */
/* ------------------------------------------------------------------ */

let jsdomReady = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
function ensureDomPolyfills(): void {
  if (jsdomReady) return;
  // Lazy-load jsdom + polyfill globals for three.js server-side usage.
  // Using require() to avoid type issues with @types/jsdom in server tsconfig.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const w = dom.window;
  const g = globalThis as any;
  g.window = w;
  g.document = w.document;
  g.self = w;
  g.Blob = w.Blob;
  g.URL = w.URL;
  g.navigator = w.navigator;
  g.HTMLCanvasElement = w.HTMLCanvasElement;
  g.WebGLRenderingContext = w.WebGLRenderingContext;
  g.OffscreenCanvas = class OffscreenCanvas {
    width = 0;
    height = 0;
    getContext() { return null; }
    toDataURL() { return ''; }
  };
  g.ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(dataOrWidth: any, heightOrEncoding?: any, height?: any) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth;
        this.width = heightOrEncoding;
        this.height = height;
      } else {
        this.width = dataOrWidth;
        this.height = heightOrEncoding;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
  jsdomReady = true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function convertObjToGlb(objBuffer: Buffer): Promise<Buffer> {
  ensureDomPolyfills();
  const THREE = await import('three');
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

  const objText = objBuffer.toString('utf8');
  const loader = new OBJLoader();
  const group: any = loader.parse(objText);

  // Apply flat grey material if none present
  const hasMaterials = group.children.some(
    (c: any) => c.isMesh && c.material !== undefined,
  );
  if (!hasMaterials) {
    const flat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.8, metalness: 0.05 });
    group.traverse((child: any) => {
      if (child.isMesh) child.material = flat;
    });
  }

  // Center on X/Z, rest on floor at Y=0
  const bbox = new THREE.Box3().setFromObject(group);
  const center = bbox.getCenter(new THREE.Vector3());
  group.position.set(-center.x, -bbox.min.y, -center.z);

  // Enable shadows
  group.traverse((child: any) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  // Export as binary GLB
  return new Promise<Buffer>((resolve, reject) => {
    new GLTFExporter().parse(
      group,
      (result: any) => resolve(Buffer.from(result as ArrayBuffer)),
      (err: any) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true },
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Thumbnail generation                                               */
/* ------------------------------------------------------------------ */

async function generateThumbnail(buffer: Buffer, ext: string): Promise<Buffer | null> {
  try {
    // Generate a simple placeholder thumbnail: grey gradient with file-type indicator
    const colors: Record<string, { r: number; g: number; b: number }> = {
      '.glb': { r: 100, g: 149, b: 237 },  // cornflower blue
      '.gltf': { r: 60, g: 179, b: 113 },   // medium sea green
      '.obj': { r: 255, g: 165, b: 0 },     // orange
    };
    const c = colors[ext] ?? { r: 180, g: 180, b: 180 };
    return sharp({
      create: {
        width: 192,
        height: 144,
        channels: 3,
        background: c,
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Multipart parser                                                   */
/* ------------------------------------------------------------------ */

function parseMultipart(
  req: Request,
): Promise<{ fileBuffer: Buffer; filename: string; metadata: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
    });

    let fileBuffer: Buffer | null = null;
    let filename = '';
    const metadata: Record<string, string> = {};

    busboy.on('field', (name: string, value: string) => {
      metadata[name] = value;
    });

    busboy.on('file', (_fieldname: string, file: any, info: any) => {
      filename = info.filename || 'upload.glb';
      const chunks: Buffer[] = [];

      file.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on('finish', () => {
      if (!fileBuffer) {
        reject(new Error('no file uploaded'));
        return;
      }
      resolve({ fileBuffer, filename, metadata });
    });

    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function modelUploadRouter(db: DbAdapter): Router {
  const router = Router();

  router.use(requireAuth);
  router.use(makeUserRateLimiter(MODEL_UPLOAD_RATE_LIMIT));

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;

      const { fileBuffer, filename, metadata } = await parseMultipart(req);

      // --- Format validation ---
      const ext = `.${(filename.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase()}`;
      if (!VALID_EXTENSIONS.includes(ext)) {
        res.status(400).json({
          error: `unsupported format ${ext} — only ${VALID_EXTENSIONS.join(', ')} allowed`,
        });
        return;
      }

      const formatError = validateModelFormat(fileBuffer, ext);
      if (formatError) {
        res.status(422).json({ error: formatError });
        return;
      }

      // --- Metadata extraction ---
      const name = metadata.name?.trim() || filename.replace(/\.[^.]+$/, '');
      const category = VALID_CATEGORIES.includes(metadata.category as any) ? metadata.category : 'Other';
      const width = Math.min(500, Math.max(0, Number(metadata.width) || 0));
      const depth = Math.min(500, Math.max(0, Number(metadata.depth) || 0));
      const height = Math.min(500, Math.max(0, Number(metadata.height) || 0));
      const color = metadata.color ? Number(metadata.color) : null;

      // --- Geometry normalization: OBJ → GLB ---
      let uploadBuffer: Buffer;
      let uploadExt = ext;

      if (ext === '.obj') {
        try {
          uploadBuffer = await convertObjToGlb(fileBuffer);
          uploadExt = '.glb';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(422).json({ error: `failed to convert OBJ to GLB: ${msg}` });
          return;
        }
      } else {
        uploadBuffer = fileBuffer;
      }

      // --- IDs & paths ---
      const id = randomUUID();
      const slug = slugify(name);
      const r2Key = `models/${id}-${slug}${uploadExt}`;
      const publicUrl = process.env.R2_PUBLIC_URL ?? '';
      const modelUrl = `${publicUrl}/${r2Key}`;

      // --- Upload model to R2 ---
      const s3 = getS3Client();
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: uploadBuffer,
        ContentType: uploadExt === '.glb' ? 'model/gltf-binary' : 'application/octet-stream',
      }));

      // --- Thumbnail generation & upload ---
      let thumbnailUrl: string | null = null;
      const thumbBuffer = await generateThumbnail(uploadBuffer, uploadExt);
      if (thumbBuffer) {
        const thumbKey = `thumbnails/${id}-${slug}.jpg`;
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: 'image/jpeg',
        }));
        thumbnailUrl = `${publicUrl}/${thumbKey}`;
      }

      // --- DB insert ---
      const catalogId = `user#${slug}`;
      await db.run(
        `INSERT INTO assets
           (id, user_id, catalog_id, name, category, width, depth, height, color, blob_key, glb_path, source_path, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, userId, catalogId, name, category,
        width, depth, height, color,
        `blob:${id}`, r2Key, null,
        uploadBuffer.byteLength, Date.now(),
      );

      // --- Response ---
      res.status(201).json({
        catalogId,
        name,
        category,
        modelPath: r2Key,
        modelUrl,
        thumbnailPath: thumbnailUrl,
        thumbnailUrl,
        width,
        depth,
        height,
        color,
        sizeBytes: uploadBuffer.byteLength,
        createdAt: Date.now(),
      });
    }),
  );

  return router;
}
