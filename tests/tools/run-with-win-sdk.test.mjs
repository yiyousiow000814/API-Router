import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sourcePath = path.resolve('tools', 'windows', 'run-with-win-sdk.mjs')

function spawnOptionsFor(marker) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const index = source.indexOf(marker)
  expect(index).toBeGreaterThanOrEqual(0)
  const tail = source.slice(index)
  const start = tail.indexOf('{')
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let offset = start; offset < tail.length; offset += 1) {
    const char = tail[offset]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return tail.slice(start, offset + 1)
    }
  }
  throw new Error(`spawn options not found for ${marker}`)
}

describe('run-with-win-sdk hidden Windows launches', () => {
  it('keeps direct child processes hidden', () => {
    expect(spawnOptionsFor('spawn(cmd, commandArgs')).toContain('windowsHide: true')
  })

  it('keeps shell fallback child processes hidden', () => {
    expect(spawnOptionsFor('spawn(shellCmd')).toContain('windowsHide: true')
  })
})
