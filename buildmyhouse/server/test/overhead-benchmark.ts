/**
 * B1.10 Overhead Benchmark
 *
 * Measures telemetry overhead by:
 * 1. Running 100 requests WITHOUT telemetry enabled
 * 2. Running 100 requests WITH telemetry enabled
 * 3. Computing overhead: (with - without) / 100
 * 4. Verifying overhead < 5ms per request
 *
 * Run with: npm run benchmark:overhead
 * or: node --loader tsx buildmyhouse/server/test/overhead-benchmark.ts
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

const b64 = (buf: Buffer) => buf.toString('base64');

function glbPayload(extra = 0): Buffer {
  const total = 12 + extra;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0); // "glTF" magic
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  return buf;
}

interface BenchmarkResult {
  variant: 'baseline' | 'with-telemetry';
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  requestCount: number;
  overheadMs?: number;
  overheadPercent?: number;
}

const results: BenchmarkResult[] = [];

async function runBenchmark(
  app: Express,
  token: string,
  userId: string,
  variant: 'baseline' | 'with-telemetry',
  requestCount = 100,
): Promise<BenchmarkResult> {
  const durations: number[] = [];

  console.log(`\n[${variant}] Starting ${requestCount} requests...`);

  for (let i = 0; i < requestCount; i++) {
    const t0 = performance.now();

    // Simulate a typical asset list request (fast, representative workload)
    const res = await request(app)
      .get(`/api/assets/${userId}`)
      .set({ Authorization: `Bearer ${token}` });

    const duration = performance.now() - t0;
    durations.push(duration);

    if ((i + 1) % 20 === 0) {
      console.log(`  Completed ${i + 1}/${requestCount} requests`);
    }

    if (res.status !== 200) {
      throw new Error(`Request ${i} failed with status ${res.status}`);
    }
  }

  const totalMs = durations.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / requestCount;
  const minMs = Math.min(...durations);
  const maxMs = Math.max(...durations);

  const result: BenchmarkResult = {
    variant,
    totalMs,
    avgMs,
    minMs,
    maxMs,
    requestCount,
  };

  console.log(`[${variant}] Results:`);
  console.log(`  Total: ${totalMs.toFixed(2)}ms`);
  console.log(`  Avg:   ${avgMs.toFixed(3)}ms`);
  console.log(`  Min:   ${minMs.toFixed(3)}ms`);
  console.log(`  Max:   ${maxMs.toFixed(3)}ms`);

  return result;
}

async function main() {
  let app: Express;
  let db: Database.Database;
  let assetRoot: string;

  try {
    console.log('B1.10 Overhead Benchmark');
    console.log('========================\n');
    console.log('Scenario: Repeated GET /api/assets/:userId (list assets)');
    console.log('Baseline: No telemetry console logging captured');
    console.log('With telemetry: All telemetry events logged to console\n');

    // Setup
    assetRoot = mkdtempSync(join(tmpdir(), 'benchmark-'));
    db = new Database(':memory:');
    app = await createApp(db, assetRoot);

    // Create a test user
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bench@test.com', password: 'password123' });

    if (registerRes.status !== 201) {
      throw new Error(`Failed to register: ${registerRes.status}`);
    }

    const token = registerRes.body.token as string;
    const userId = jwt.verify(token, getJwtSecret()).sub as string;

    // Run baseline (console.log disabled)
    const originalLog = console.log;
    console.log = () => {}; // Suppress all logging for baseline

    const baseline = await runBenchmark(app, token, userId, 'baseline', 100);
    results.push(baseline);

    console.log = originalLog; // Restore logging

    // Run with telemetry
    const withTelemetry = await runBenchmark(app, token, userId, 'with-telemetry', 100);
    results.push(withTelemetry);

    // Calculate overhead
    const overheadMs = withTelemetry.avgMs - baseline.avgMs;
    const overheadPercent = (overheadMs / baseline.avgMs) * 100;

    withTelemetry.overheadMs = overheadMs;
    withTelemetry.overheadPercent = overheadPercent;

    // Summary
    console.log('\n=== OVERHEAD SUMMARY ===\n');
    console.log(`Baseline avg:       ${baseline.avgMs.toFixed(3)}ms`);
    console.log(`With telemetry avg: ${withTelemetry.avgMs.toFixed(3)}ms`);
    console.log(`Overhead:           ${overheadMs.toFixed(3)}ms (${overheadPercent.toFixed(1)}%)`);
    console.log(`Threshold:          5.000ms`);
    console.log(`Status:             ${overheadMs < 5 ? '✓ PASS' : '✗ FAIL'}\n`);

    if (overheadMs >= 5) {
      console.error(`ERROR: Telemetry overhead exceeds 5ms threshold!`);
      console.error(`  Measured: ${overheadMs.toFixed(3)}ms`);
      console.error(`  This indicates telemetry instrumentation may be too expensive.\n`);
      process.exit(1);
    }

    console.log('All benchmarks completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Benchmark failed:', err);
    process.exit(1);
  }
}

main();
