#!/usr/bin/env node
import assert from 'node:assert/strict'
import { AssetIngestionService, classifyTransform } from '../src/services/asset-ingestion-service.js'

function selfTest(): void {
  const dims: [number, number] = [88.5, 56.1]
  assert.equal(classifyTransform([7.9, 8, 5], dims).status, 'pass-scale')
  assert.equal(classifyTransform([5, 8, 7.9], dims).status, 'axis-swap')
  assert.equal(classifyTransform([80, 30, 50], [100, 100]).status, 'ambiguous')
  assert.equal(classifyTransform([80, 30, 80], [100, 50]).status, 'ambiguous')
  console.log('transform classifier self-test passed')
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) return selfTest()
  const service = new AssetIngestionService()
  const items = service.parseLibrary()
  const counts = { pass: 0, 'pass-scale': 0, 'axis-swap': 0, ambiguous: 0, errors: 0 }
  for (const item of items) {
    try {
      const check = service.checkTransform(item)
      counts[check.status]++
      const rotationHelped = item.rotation && check.rawError !== null && check.rawError !== undefined && check.rawError > 0.05 && (check.status === 'pass' || check.status === 'pass-scale')
      console.log(`${check.status.padEnd(10)} ${item.catalogId} err=${check.error?.toFixed(3) ?? 'n/a'} swap=${check.swapError?.toFixed(3) ?? 'n/a'}${check.scale === null ? '' : ` scale=${check.scale.toFixed(3)}`}${rotationHelped ? ' rotation-aligns-footprint' : ''}${check.reason ? ` (${check.reason})` : ''}`)
    } catch (error) {
      counts.errors++
      console.error(`error      ${item.catalogId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`summary ${JSON.stringify({ total: items.length, ...counts })}`)
  if (counts['axis-swap'] > 0 || counts.errors > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
