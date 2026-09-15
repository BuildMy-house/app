#!/usr/bin/env node
/**
 * render-thumbnails.ts — MAT-T9: prebake catalog thumbnails at build time.
 *
 *   npm run thumbnails          # render assets/thumbs/<modelPath>.webp per item
 *
 * For every catalog.json item with a modelPath (a local GLB under assets/, or
 * an external R2 URL whose thumbnail uploads to thumbs/ in the same bucket),
 * renders the model with headless Chromium (Playwright — already a
 * devDependency for e2e) using the same orthographic 3/4-view framing as the
 * runtime fallback in src/ui/model-thumbnail.ts, and saves a WebP next to the
 * GLBs under assets/thumbs/ (mirrored to public/ by `npm run assets` sync).
 *
 * CatalogPanel serves these as plain <img loading="lazy">; the live WebGL
 * render stays as the runtime fallback for user imports / missing files.
 *
 * One thumbnail convention is shared with the panel: the thumbnail for
 * `models/foo.glb` is `thumbs/models/foo.webp` (extension swapped, path kept).
 *
 * Individual model failures are logged and skipped (the runtime fallback
 * covers them); the script only fails hard if the browser cannot run at all.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_SRC = join(ROOT, 'assets', 'catalog', 'catalog.json')
const MODELS_DIR = join(ROOT, 'assets')
const THUMBS_DIR = join(ROOT, 'assets', 'thumbs')

const THUMB_W = 384
const THUMB_H = 288

interface CatalogItem {
  catalogId: string
  name: string
  modelPath?: string | null
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogItem[]
}

/** Externally-hosted model (e.g. Cloudflare R2) — mirrors scripts/assets.ts. */
function isExternalModel(modelPath: string): boolean {
  return /^https?:\/\//i.test(modelPath)
}

/** R2 object key for an external model's thumbnail: .../models/x.glb -> thumbs/x.webp. */
function externalThumbKey(modelPath: string): string {
  const base = new URL(modelPath).pathname.split('/').pop() ?? ''
  return `thumbs/${base.replace(/\.[^.]+$/, '')}.webp`
}

/** Thumbnail path for a modelPath, mirroring the CatalogPanel convention. */
function thumbPath(modelPath: string): string {
  return join(THUMBS_DIR, modelPath.replace(/\.[^.]+$/, '') + '.webp')
}

function getS3Client(): S3Client {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT } = process.env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT) {
    fail('external models present but R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT are not set')
  }
  return new S3Client({
    region: 'auto',
    endpoint: R2_S3_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
}

/**
 * In-browser renderer. Bundled with esbuild and injected via addScriptTag so
 * three.js + GLTFLoader run inside headless Chromium without a dev server.
 * Framing/lighting mirror src/ui/model-thumbnail.ts (ortho, 3/4 view, ambient
 * 0.6 + key 0.8) so prebaked and fallback thumbnails look the same.
 */
const RENDERER_SOURCE = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const W = ${THUMB_W}
const H = ${THUMB_H}
let renderer = null
let scene = null
let camera = null

function init() {
  if (renderer) return true
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(W, H)
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 0.8)
  key.position.set(2, 3, 2)
  scene.add(key)
  camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 100)
  camera.position.set(0, 0.5, 5)
  camera.lookAt(0, 0.4, 0)
  return true
}

window.__renderThumb = async (dataUrl) => {
  if (!init()) return null
  const gltf = await new GLTFLoader().loadAsync(dataUrl)
  const model = gltf.scene
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  if (!(maxDim > 0)) return null
  const scale = 1.6 / maxDim
  model.scale.setScalar(scale)
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale)
  model.position.sub(center)
  model.rotation.y = -0.6
  scene.add(model)
  renderer.render(scene, camera)
  const data = renderer.domElement.toDataURL('image/webp', 0.85)
  scene.remove(model)
  model.traverse((child) => {
    const mesh = child
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
  return data
}
`

function fail(message: string): never {
  console.error(`[thumbs] ERROR: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(CATALOG_SRC, 'utf8')) as CatalogManifest
  const jobs = manifest.items.filter(
    (item) =>
      item.modelPath &&
      (isExternalModel(item.modelPath) || existsSyncQuiet(join(MODELS_DIR, item.modelPath))),
  )
  console.log(`[thumbs] rendering ${jobs.length} thumbnails (${manifest.items.length} catalog items)`)

  const s3 = jobs.some((item) => isExternalModel(item.modelPath!)) ? getS3Client() : null

  const tmp = mkdtempSync(join(tmpdir(), 'thumbs-'))
  const bundle = join(tmp, 'renderer.js')
  await build({
    stdin: { contents: RENDERER_SOURCE, loader: 'ts', resolveDir: ROOT },
    bundle: true,
    format: 'iife',
    outfile: bundle,
    minify: false,
    logLevel: 'silent',
  })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: THUMB_W, height: THUMB_H } })
  await page.goto('about:blank')
  await page.addScriptTag({ path: bundle })

  let written = 0
  let skipped = 0
  for (const item of jobs) {
    const external = isExternalModel(item.modelPath!)
    try {
      let glb: Buffer
      if (external) {
        const res = await fetch(item.modelPath!)
        if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
        glb = Buffer.from(await res.arrayBuffer())
      } else {
        glb = readFileSync(join(MODELS_DIR, item.modelPath!))
      }
      const dataUrl = `data:model/gltf-binary;base64,${glb.toString('base64')}`
      const result = (await page.evaluate(async (url) => {
        return await (window as unknown as { __renderThumb: (u: string) => Promise<string | null> }).__renderThumb(url)
      }, dataUrl)) as string | null
      if (!result || !result.startsWith('data:image/webp;base64,')) {
        skipped++
        console.warn(`[thumbs] skip ${item.catalogId}: renderer returned no image`)
        continue
      }
      const webp = Buffer.from(result.slice('data:image/webp;base64,'.length), 'base64')
      if (external) {
        await s3!.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: externalThumbKey(item.modelPath!),
          Body: webp,
          ContentType: 'image/webp',
        }))
      } else {
        const out = thumbPath(item.modelPath!)
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, webp)
      }
      written++
    } catch (err) {
      skipped++
      console.warn(`[thumbs] skip ${item.catalogId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await browser.close()
  if (written === 0 && jobs.length > 0) fail('no thumbnails written — browser/renderer unavailable?')
  console.log(`[thumbs] done: ${written} written, ${skipped} skipped -> ${THUMBS_DIR}`)
}

function existsSyncQuiet(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
