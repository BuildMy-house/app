import { describe, it, expect } from 'vitest'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { configureGltfLoader } from './scene'

/**
 * MAT-T3: all GLTFLoader sites (scene model loader, catalog thumbnails,
 * import validation) must share one KTX2Loader pointed at the served Basis
 * transcoder, so KTX2-compressed GLBs decode instead of failing to parse.
 * detectSupport cannot run in the node test environment (no WebGL) — that
 * path is covered by the e2e suite in a real browser.
 */
describe('KTX2 loader wiring (MAT-T3)', () => {
  it('attaches a shared KTX2Loader with the served transcoder path', () => {
    const a = configureGltfLoader(new GLTFLoader())
    const b = configureGltfLoader(new GLTFLoader())
    expect(a.ktx2Loader).not.toBeNull()
    expect(a.ktx2Loader).toBe(b.ktx2Loader) // one shared singleton
    expect(a.ktx2Loader!.transcoderPath).toBe('assets/basis/')
  })
})
