import fs from 'node:fs'
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
const API_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Vision judging tier. Runs claude-haiku-4-5 over every fail/borderline
 * screenshot plus a ~10% random sample of passes, merging visionVerdict /
 * visionNotes into each record. Informational only — never overrides the
 * heuristic verdict and never hard-fails the run: unset key or any API error
 * degrades to a one-line warning and the record keeps no vision fields.
 */
export async function judgeScreenshots(records: QualityRecord[]): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    console.warn('[quality-rating] ANTHROPIC_API_KEY not set — skipping vision judging tier')
    return
  }

  const toJudge = records.filter((r) => r.heuristic.verdict !== 'pass')
  for (const r of records) {
    if (r.heuristic.verdict === 'pass' && Math.random() < 0.1) toJudge.push(r)
  }
  if (toJudge.length === 0) return
  console.log(`[quality-rating] vision judging ${toJudge.length}/${records.length} records`)

  for (const record of toJudge) {
    try {
      const imageBase64 = fs.readFileSync(path.resolve(record.screenshot)).toString('base64')
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
                },
                {
                  type: 'text',
                  text:
                    `You are judging a 3D interior-design viewport render (scene "${record.scene}", ` +
                    `quality preset "${record.tier}", camera "${record.camera}"). ` +
                    'Look for obvious rendering defects: missing/black surfaces, z-fighting, ' +
                    'broken or floating furniture, wrong shadows, missing textures, glitched geometry. ' +
                    'Reply with ONLY a JSON object: ' +
                    '{"verdict":"pass|borderline|fail","notes":"one short sentence"}.',
                },
              ],
            },
          ],
        }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }
      const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> }
      const text = (data.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0]) as { verdict?: string; notes?: string }
        if (parsed.verdict === 'pass' || parsed.verdict === 'borderline' || parsed.verdict === 'fail') {
          record.visionVerdict = parsed.verdict
          record.visionNotes = parsed.notes
          continue
        }
      }
      record.visionVerdict = 'error'
      record.visionNotes = `unparseable model reply: ${text.slice(0, 200)}`
    } catch (err) {
      console.warn(
        `[quality-rating] vision judge failed for ${record.scene}/${record.tier}/${record.camera}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
