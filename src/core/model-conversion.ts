import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

/** Convert a user OBJ/MTL pair to the GLB consumed by the browser renderer. */
export function objToGlb(objText: string, mtlText?: string): Promise<ArrayBuffer> {
  const loader = new OBJLoader()
  if (mtlText) loader.setMaterials(new MTLLoader().parse(mtlText, ''))
  const object = loader.parse(objText)
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(object, (result) => {
      if (!(result instanceof ArrayBuffer)) return reject(new Error('OBJ conversion did not produce GLB'))
      resolve(result)
    }, reject, { binary: true })
  })
}
