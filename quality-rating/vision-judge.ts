import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Grade } from './heuristics'

/** One capture result as written into summary.json / latest.json. */
export interface QualityRecord {
  runId: string
  scene: string
  tier: string
  camera: string
  /** Screenshot path relative to the repo root. */
  screenshot: string
  snapshot: Record<string, unknown>
  heuristic: Grade
  visionVerdict?: 'pass' | 'borderline' | 'fail' | 'error'
  visionNotes?: string
}

const MODEL = 'claude-haiku-4-5'

/**
 * Vision judging tier. Selects every fail/borderline screenshot plus a ~10%
 * random sample of passes, then judges them ALL in ONE headless invocation of
 * the local `claude` CLI (`claude --print`, authenticated via Claude Code's
 * normal login — no API key of our own), merging visionVerdict / visionNotes
 * into each record. One process per run, not per screenshot: a single `claude
 * --print` call carries a large fixed cost regardless of how many images it
 * grades, so batching keeps the tier cheap. Informational only — never
 * overrides the heuristic verdict and never hard-fails the run: `claude`
 * missing from PATH, exiting non-zero, or replying with unparseable output
 * degrades to ONE warning line and the records keep no vision fields.
 */
export async function judgeScreenshots(records: QualityRecord[]): Promise<void> {
  const toJudge = records.filter((r) => r.heuristic.verdict !== 'pass')
  for (const r of records) {
    if (r.heuristic.verdict === 'pass' && Math.random() < 0.1) toJudge.push(r)
  }
  if (toJudge.length === 0) return
  console.log(`[quality-rating] vision judging ${toJudge.length}/${records.length} records`)

  const prompt = [
    'You are judging 3D interior-design viewport renders for obvious rendering defects (missing/black surfaces, z-fighting, broken or floating furniture, wrong shadows, missing textures, glitched geometry).',
    '',
    'Read each image file below with the Read tool, then reply with ONLY a single JSON array (no markdown fences, no prose), one object per image in the SAME ORDER given, each shaped exactly:',
    '{"index":<n>,"verdict":"pass|borderline|fail","notes":"one short sentence"}',
    '',
    'Images:',
    ...toJudge.map(
      (r, i) =>
        `${i + 1}. ${path.resolve(r.screenshot)} (scene "${r.scene}", tier "${r.tier}", camera "${r.camera}")`,
    ),
    '',
  ].join('\n')

  let reply: string
  try {
    reply = await runClaude(prompt)
  } catch (err) {
    console.warn(
      `[quality-rating] vision judge failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }

  // The reply is sometimes wrapped in a ```json fence despite the instruction.
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const match = text.match(/\[[\s\S]*\]/)
  let entries: unknown[]
  try {
    const parsed: unknown = JSON.parse(match ? match[0] : text)
    if (!Array.isArray(parsed)) throw new Error('reply is not a JSON array')
    entries = parsed
  } catch {
    console.warn(
      `[quality-rating] vision judge produced unparseable output: ${text.slice(0, 200)}`,
    )
    return
  }

  const byIndex = new Map<number, { verdict?: unknown; notes?: unknown }>()
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object') {
      const withIndex = entry as { index?: unknown }
      if (typeof withIndex.index === 'number') {
        byIndex.set(withIndex.index, entry as { verdict?: unknown; notes?: unknown })
      }
    }
  }

  toJudge.forEach((record, i) => {
    const entry = byIndex.get(i + 1)
    const verdict = entry?.verdict
    if (verdict === 'pass' || verdict === 'borderline' || verdict === 'fail') {
      record.visionVerdict = verdict
      if (typeof entry?.notes === 'string') record.visionNotes = entry.notes
      return
    }
    record.visionVerdict = 'error'
    record.visionNotes = `unparseable model reply: ${JSON.stringify(entry ?? text).slice(0, 200)}`
  })
}

/**
 * Run one headless `claude --print` process with the prompt on STDIN (a
 * prompt CLI argument was verified to fail unreliably in dispatched shells)
 * and resolve the model's `result` text from its JSON reply.
 */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['--print', '--output-format', 'json', '--allowedTools', 'Read', '--model', MODEL],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim().slice(0, 200) || err.message))
          return
        }
        try {
          const data = JSON.parse(stdout) as { result?: unknown }
          if (typeof data.result !== 'string') throw new Error('missing result field')
          resolve(data.result)
        } catch {
          reject(new Error(`unparseable claude reply: ${stdout.slice(0, 200)}`))
        }
      },
    )
    // claude may die before the prompt lands (e.g. not on PATH); the execFile
    // callback reports the real failure — stdin errors must not crash the run.
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
  })
}
