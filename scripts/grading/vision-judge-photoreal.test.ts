import { describe, expect, it, vi } from 'vitest'
import { judgePhotorealBatch, type PhotorealJudgeInput } from './vision-judge-photoreal'

const inputs: PhotorealJudgeInput[] = [
  { catalogId: 'armchair', screenshotPath: 'renders/armchair.png' },
  { catalogId: 'sofa-3-seater', screenshotPath: 'renders/sofa.png' },
]

describe('judgePhotorealBatch', () => {
  it('parses a successful batch reply and maps scores by index', async () => {
    const runner = vi.fn().mockResolvedValue(
      JSON.stringify([
        { index: 1, renderFidelity: 82, uvVisionScore: 95, notes: 'slight aliasing' },
        { index: 2, renderFidelity: 41, uvVisionScore: 30, notes: 'flat lighting, stretched seat texture' },
      ]),
    )
    const results = await judgePhotorealBatch(inputs, runner)
    expect(results).toEqual([
      { catalogId: 'armchair', renderFidelity: 82, uvVisionScore: 95, notes: 'slight aliasing' },
      {
        catalogId: 'sofa-3-seater',
        renderFidelity: 41,
        uvVisionScore: 30,
        notes: 'flat lighting, stretched seat texture',
      },
    ])
    expect(runner).toHaveBeenCalledOnce()
  })

  it('parses a markdown-fenced reply', async () => {
    const runner = vi.fn().mockResolvedValue(
      '```json\n' +
        JSON.stringify([{ index: 1, renderFidelity: 70, uvVisionScore: 100, notes: 'clean' }]) +
        '\n```',
    )
    const results = await judgePhotorealBatch([inputs[0]], runner)
    expect(results).toEqual([
      { catalogId: 'armchair', renderFidelity: 70, uvVisionScore: 100, notes: 'clean' },
    ])
  })

  it('returns -1 scores for every input when the reply is unparseable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = vi.fn().mockResolvedValue('I cannot judge these images, sorry.')
    const results = await judgePhotorealBatch(inputs, runner)
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.renderFidelity).toBe(-1)
      expect(r.uvVisionScore).toBe(-1)
      expect(r.notes).toContain('unparseable model reply')
    }
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('returns -1 scores instead of throwing when the claude CLI fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = vi.fn().mockRejectedValue(new Error('spawn claude ENOENT'))
    const results = await judgePhotorealBatch(inputs, runner)
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.renderFidelity).toBe(-1)
      expect(r.uvVisionScore).toBe(-1)
      expect(r.notes).toContain('claude CLI failure')
      expect(r.notes).toContain('ENOENT')
    }
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('short-circuits on empty input without invoking claude', async () => {
    const runner = vi.fn()
    await expect(judgePhotorealBatch([], runner)).resolves.toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })
})
