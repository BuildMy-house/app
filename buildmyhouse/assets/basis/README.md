# Basis Universal transcoder (for three.js KTX2Loader)

Copied verbatim from `three@0.185.1` (`node_modules/three/examples/jsm/libs/basis/`).

- Upstream: https://github.com/KhronosGroup/KTX-Software (Basis Universal transcoder)
- License: Apache-2.0 (with clauses); the files ship inside the MIT-licensed
  three.js package this repo already depends on.

Serving: this directory is mirrored into gitignored `public/assets/basis/` by
`npm run assets` (scripts/assets.ts), same tracked-source convention as
textures and models. `KTX2Loader.setTranscoderPath('assets/basis/')` in
`src/view3d/scene.ts` fetches `basis_transcoder.js` + `.wasm` from there.
