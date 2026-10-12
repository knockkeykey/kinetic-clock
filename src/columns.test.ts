import { describe, expect, it } from 'vitest'
import { firstColumnUnused } from './columns'
import { compose, isBlank } from './glyphs'
import { sample, Scheduler } from './scheduler'

describe('first column visibility', () => {
  it('only hides when all three clocks in the first column are unused', () => {
    const lens = new Float32Array(24).fill(1)
    expect(firstColumnUnused(lens)).toBe(false)
    for (const i of [0, 8, 16]) {
      lens[i] = 0
      expect(firstColumnUnused(lens)).toBe(i === 16)
    }
    // 任意一只钟开始伸出，就不能再把整列藏起来。
    for (const i of [0, 8, 16]) {
      lens[i] = 0.01
      expect(firstColumnUnused(lens)).toBe(false)
      lens[i] = 0
    }
  })

  it('keeps the first column when only a different column is blank', () => {
    const lens = new Float32Array(24).fill(1)
    for (const i of [1, 9, 17]) lens[i] = 0
    expect(firstColumnUnused(lens)).toBe(false)
  })

  it.each(['0100', '1000', '1100', '1200', '2100', ' 5°C'])('hides the unused first column of %s', (text) => {
    const lens = Float32Array.from(compose(text), (hands) => isBlank(hands) ? 0 : 1)
    expect(firstColumnUnused(lens)).toBe(true)
  })

  it.each(['0200', '0800', '2200', '2000', '-5°C'])('preserves the required first column of %s', (text) => {
    const lens = Float32Array.from(compose(text), (hands) => isBlank(hands) ? 0 : 1)
    expect(firstColumnUnused(lens)).toBe(false)
  })

  it('follows scheduled time changes without hiding a required clock', () => {
    const scheduler = new Scheduler({ takeoverEvery: () => 0, temperature: () => null })
    const angles = new Float32Array(48), lens = new Float32Array(24)
    for (const [hour, minute, hidden] of [[19, 59, true], [20, 0, false], [20, 59, false], [21, 0, true]] as const) {
      const now = new Date(2026, 9, 12, hour, minute, 5).getTime()
      sample(scheduler.at(now), now, angles, lens)
      expect(firstColumnUnused(lens)).toBe(hidden)
    }
  })
})
