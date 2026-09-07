import { accessSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

installNodePolyfills()

import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'

const SH3D_RESOURCES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'models',
  'sh3d',
)

interface CatalogItem {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  color?: number | null
}

/** True when the SH3D resources contain an OBJ matching this catalogId (eTeks#name -> name.obj). */
export function hasSh3dModel(catalogId: string): boolean {
  const name = catalogId.split('#')[1]
  if (!name) return false
  try {
    accessSync(join(SH3D_RESOURCES, `${name}.obj`))
    return true
  } catch {
    return false
  }
}

/**
 * Convert a Sweet Home 3D OBJ into a three.js Group scaled to the catalog dims.
 * Returns null if the OBJ cannot be read or parsed.
 *
 * The model is uniformly scaled so its largest axis matches the catalog's
 * largest axis, then centered on X/Z and set on the floor at Y=0.
 */
export function convertSh3dModel(item: CatalogItem): THREE.Group | null {
  const name = item.catalogId.split('#')[1]
  if (!name) return null

  const objPath = join(SH3D_RESOURCES, `${name}.obj`)
  let objText: string
  try {
    objText = readFileSync(objPath, 'utf8')
  } catch {
    return null
  }

  const objLoader = new OBJLoader()
  let group: THREE.Group

  const mtlPath = join(SH3D_RESOURCES, `${name}.mtl`)
  try {
    accessSync(mtlPath)
    const mtlText = readFileSync(mtlPath, 'utf8')
    const materialCreator = new MTLLoader().parse(mtlText, SH3D_RESOURCES + '/')
    materialCreator.preload()
    group = objLoader.setMaterials(materialCreator).parse(objText)
  } catch {
    group = objLoader.parse(objText)
    const fallbackMaterial = new THREE.MeshStandardMaterial({
      color: item.color ?? 0x9e9e9e,
      roughness: 0.8,
      metalness: 0.05,
    })

    const faceCount = (objText.match(/^f\s/gm) ?? []).length
    const facesWithUv = (objText.match(/^f\s.*\d+\/\d+/gm) ?? []).length
    if (faceCount > 0 && facesWithUv / faceCount > 0.5) {
      const pngPath = join(SH3D_RESOURCES, `${name}.png`)
      try {
        accessSync(pngPath)
        const img = document.createElement('img') as HTMLImageElement
        img.src = `file://${pngPath}`
        if (img.complete) {
          fallbackMaterial.map = new THREE.Texture(img)
          fallbackMaterial.map.needsUpdate = true
        }
      } catch {
        // No matching PNG — keep flat color
      }
    }

    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = fallbackMaterial
      }
    })
  }

  const bbox = new THREE.Box3().setFromObject(group)
  const size = new THREE.Vector3()
  bbox.getSize(size)
  const modelMax = Math.max(size.x, size.y, size.z)
  if (modelMax === 0) return null

  const catalogMax = Math.max(item.width, item.depth, item.height)
  const scale = catalogMax / modelMax
  group.scale.setScalar(scale)

  const center = new THREE.Vector3()
  bbox.getCenter(center)
  group.position.set(-center.x * scale, -bbox.min.y * scale, -center.z * scale)

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true
      child.receiveShadow = true
    }
  })

  return group
}

/** Minimal browser-ish globals so GLTFExporter + ImageLoader run under Node. */
function installNodePolyfills(): void {
  if (typeof globalThis.document !== 'undefined') return

  function setGlobal(name: string, value: unknown): void {
    try {
      ;(globalThis as unknown as Record<string, unknown>)[name] = value
    } catch {
      // ignore read-only globals
    }
  }

  function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      return { width: 1, height: 1 }
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  function readPngFile(url: string): Buffer {
    const path = url.startsWith('file:') ? fileURLToPath(url) : url
    return readFileSync(path)
  }

  class NodeEventTarget {
    private listeners: Record<string, Array<(event: Event) => void>> = {}

    addEventListener(type: string, listener: (event: Event) => void): void {
      ;(this.listeners[type] ??= []).push(listener)
    }

    removeEventListener(type: string, listener: (event: Event) => void): void {
      const arr = this.listeners[type]
      if (!arr) return
      const index = arr.indexOf(listener)
      if (index >= 0) arr.splice(index, 1)
    }

    dispatchEvent(event: Event): void {
      this.listeners[event.type]?.forEach((listener) => listener(event))
    }
  }

  class NodeImage extends NodeEventTarget {
    complete = false
    crossOrigin: string | null = null
    private _src = ''
    width = 0
    height = 0
    private buffer: Buffer = Buffer.alloc(0)

    constructor(widthOrUrl?: number | string, height?: number) {
      super()
      if (typeof widthOrUrl === 'string') {
        this.src = widthOrUrl
      } else if (typeof widthOrUrl === 'number' && typeof height === 'number') {
        this.width = widthOrUrl
        this.height = height
      }
    }

    get src(): string { return this._src }
    set src(url: string) {
      this._src = url
      if (url) this.load(url)
    }

    private load(url: string): void {
      try {
        this.buffer = readPngFile(url)
        const dims = parsePngDimensions(this.buffer)
        this.width = dims.width
        this.height = dims.height
        this.complete = true
        this.dispatchEvent(new Event('load'))
      } catch {
        this.dispatchEvent(new Event('error'))
      }
    }
  }

  class NodeImageData {
    data: Uint8ClampedArray
    width: number
    height: number

    constructor(data: Uint8ClampedArray, width: number, height?: number)
    constructor(width: number, height: number)
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth
        this.width = widthOrHeight ?? 0
        this.height = height ?? 0
      } else {
        this.width = dataOrWidth
        this.height = widthOrHeight ?? 0
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      }
    }
  }

  class NodeCanvas {
    width = 0
    height = 0
    style: Record<string, string> = {}
    private image: NodeImage | NodeImageData | null = null

    constructor(width = 0, height = 0) {
      this.width = width
      this.height = height
    }

    getContext(_type: string, _options?: unknown) {
      return {
        drawImage: (img: NodeImage | NodeImageData, _x: number, _y: number, _w?: number, _h?: number) => {
          this.image = img
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => new NodeImageData(w, h),
        putImageData: (imgData: NodeImageData, _x: number, _y: number) => {
          this.image = imgData
        },
        translate: (_x: number, _y: number) => {},
        scale: (_x: number, _y: number) => {},
      }
    }

    toBlob(callback: (blob: Blob | null) => void, type = 'image/png'): void {
      if (this.image instanceof NodeImage && this.image.buffer.length > 0) {
        callback(new Blob([this.image.buffer], { type }))
        return
      }
      callback(null)
    }

    toDataURL(type = 'image/png'): string {
      if (this.image instanceof NodeImage && this.image.buffer.length > 0) {
        return `data:${type};base64,${this.image.buffer.toString('base64')}`
      }
      return ''
    }
  }

  class NodeDocument {
    createElement(tagName: string): NodeCanvas | NodeImage {
      if (tagName === 'canvas') return new NodeCanvas()
      if (tagName === 'img') return new NodeImage()
      return new NodeCanvas()
    }

    createElementNS(_ns: string, tagName: string): NodeCanvas | NodeImage {
      return this.createElement(tagName)
    }
  }

  setGlobal('HTMLImageElement', NodeImage)
  setGlobal('HTMLCanvasElement', NodeCanvas)
  setGlobal('Image', NodeImage)
  setGlobal('ImageData', NodeImageData)
  setGlobal('document', new NodeDocument())
}
