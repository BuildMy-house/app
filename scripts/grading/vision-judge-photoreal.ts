import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * One photoreal render screenshot to vision-judge.
 */
export interface PhotorealJudgeInput {
  catalogId: string
  /** Absolute or repo-relative path to the rendered PNG. */
  screenshotPath: string
}

/**
 * Raw vision sub-scores for one catalog asset. A score of -1 on either field
 * means "could not be vision-judged" — callers (AQS-4) must skip/retry, not
 * crash, and must not fold -1 into composite math.
 */
export interface PhotorealJudgeResult {
  catalogId: string
  /** 0-100: how photoreal (vs synthetic/flat/placeholder) the render looks. */
  renderFidelity: number
  /** 0-100: absence of UV stretching/seam artifacts (100 = none visible). */
  uvVisionScore: number
  /** Free-text issues (banding, aliasing, flat lighting, seams, stretch...). */
  notes: string
}

const MODEL = 'claude-haiku-4-5'

type ClaudeRunner = (prompt: string) => Promise<string>

function failed(catalogId: string, notes: string): PhotorealJudgeResult {
  return { catalogId, renderFidelity: -1, uvVisionScore: -1, notes }
}

/**
 * Photoreal vision-judging tier for the LuxCore asset-quality-scorecard
 * pipeline. Sends ALL screenshots in ONE headless invocation of the local
 * `claude` CLI (`claude --print`, authenticated via Claude Code's normal
 * login — no API key of our own): a single call carries a large fixed cost
 * regardless of how many images it grades, so batching keeps the tier cheap.
 *
 * Returns the raw vision sub-scores (render-fidelity + UV-stretch/seam
 * visibility). Combining with the metadata half of the UV/texture dimension
 * (`0.4*metadata + 0.6*vision`) is the caller's (AQS-4) job — this module
 * only judges pixels. Never throws: `claude` missing from PATH, exiting
 * non-zero, or replying with unparseable output degrades to ONE warning line
 * and -1 scores so a single bad batch cannot take down a grading run.
 */
export async function judgePhotorealBatch(
  inputs: PhotorealJudgeInput[],
  runClaude: ClaudeRunner = runClaudeStdin,
): Promise<PhotorealJudgeResult[]> {
  if (inputs.length === 0) return []
  console.log(`[grading] photoreal vision judging ${inputs.length} screenshot(s)`)

  const prompt = [
    'You are judging photorealistic 3D interior-design renders (LuxCore) of individual furniture assets for overall render quality.',
    '',
    'Score BOTH dimensions for each image:',
    '- "renderFidelity" (0-100): how PHOTOREAL the render looks vs synthetic/flat/placeholder. 100 = convincingly real-world product photography (natural lighting, believable materials, soft contact shadows); lower = flat placeholder lighting, obviously CG banding/aliasing, blown highlights, plastic/textureless surfaces, broken geometry.',
    '- "uvVisionScore" (0-100): specifically the ABSENCE of UV-mapping artifacts — visible texture seams, stretched/smeared textures, mirrored or wildly inconsistent texel density. 100 = no visible seams or stretching anywhere; lower = more/stronger visible seams and texture stretching.',
    '',
    'Read each image file below with the Read tool, then reply with ONLY a single JSON array (no markdown fences, no prose), one object per image in the SAME ORDER given, each shaped exactly:',
    '{"index":<n>,"renderFidelity":<0-100>,"uvVisionScore":<0-100>,"notes":"short sentence(s) on banding/aliasing/flat-lighting/blown-highlights/seams/texture-stretching"}',
    '',
    'Images:',
    ...inputs.map(
      (input, i) => `${i + 1}. ${path.resolve(input.screenshotPath)} (catalog id "${input.catalogId}")`,
    ),
    '',
  ].join('\n')

  let reply: string
  try {
    reply = await runClaude(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[grading] photoreal vision judge failed: ${msg}`)
    return inputs.map((input) => failed(input.catalogId, `claude CLI failure: ${msg}`))
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
      `[grading] photoreal vision judge produced unparseable output: ${text.slice(0, 200)}`,
    )
    return inputs.map((input) =>
      failed(input.catalogId, `unparseable model reply: ${text.slice(0, 200)}`),
    )
  }

  const byIndex = new Map<number, Record<string, unknown>>()
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object') {
      const index = (entry as { index?: unknown }).index
      if (typeof index === 'number') byIndex.set(index, entry as Record<string, unknown>)
    }
  }

  return inputs.map((input, i) => {
    const entry = byIndex.get(i + 1)
    if (!entry) return failed(input.catalogId, `missing entry for index ${i + 1} in model reply`)
    const renderFidelity = clampScore(entry.renderFidelity)
    const uvVisionScore = clampScore(entry.uvVisionScore)
    if (renderFidelity === -1 || uvVisionScore === -1) {
      return failed(
        input.catalogId,
        `invalid scores in model reply: ${JSON.stringify(entry).slice(0, 200)}`,
      )
    }
    const notes = entry.notes
    return {
      catalogId: input.catalogId,
      renderFidelity,
      uvVisionScore,
      notes: typeof notes === 'string' ? notes : '',
    }
  })
}

/** -1 when missing/non-finite/out of 0-100 (before clamping); else clamped 0-100. */
function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1
  if (value < 0 || value > 100) return -1
  return value
}

/**
 * Run one headless `claude --print` process with the prompt on STDIN (a
 * prompt CLI argument was verified to fail unreliably in dispatched shells)
 * and resolve the model's `result` text from its JSON reply.
 */
function runClaudeStdin(prompt: string): Promise<string> {
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
