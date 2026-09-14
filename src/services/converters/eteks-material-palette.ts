import { writeFileSync } from 'node:fs'

const DEFAULT_COLOR = 0xc0c0c0
const PALETTE: Array<[string[], number]> = [
  [['yellow'], 0xe5c94f],
  [['blue', 'teal'], 0x4f8fc9],
  [['red'], 0xc95757],
  [['green'], 0x5d9b62],
  [['brown', 'tan', 'amber'], 0x986b45],
  [['orange'], 0xd9823b],
  [['black'], 0x242424],
  [['white'], 0xf2f2ed],
  [['grey', 'gray'], 0x858585],
  [['bone', 'flesh', 'skin'], 0xd1a27d],
]

function colorFor(name: string): number {
  const lower = name.toLowerCase()
  return PALETTE.find(([keywords]) => keywords.some((keyword) => lower.includes(keyword)))?.[1] ?? DEFAULT_COLOR
}

function hexRgb(color: number): string {
  return [color >> 16 & 0xff, color >> 8 & 0xff, color & 0xff].map((channel) => (channel / 255).toFixed(4)).join(' ')
}

/** Create the minimal MTL needed to preserve OBJ usemtl groups without fake textures. */
export function synthesizeEteksMtl(objText: string, outputPath: string): string {
  const names = [...new Set([...objText.matchAll(/^usemtl\s+(.+)$/gm)].map((match) => match[1]?.trim()).filter((name): name is string => Boolean(name)))]
  const text = names.map((name) => `newmtl ${name}\nKd ${hexRgb(colorFor(name))}\nKa 0 0 0\nKs 0 0 0\nNs 0\n`).join('\n')
  writeFileSync(outputPath, text)
  return outputPath
}
