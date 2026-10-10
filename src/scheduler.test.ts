import { describe, expect, it } from 'vitest'
import { compose, tempText } from './glyphs'
import { Scheduler, sample, type Segment } from './scheduler'

const mod = (a: number) => ((Math.round(a) % 360) + 360) % 360
const poseAt = (seg: Segment, t: number) => { const o = new Float32Array(48); sample(seg, t, o); return [...o].map(mod) }
const flat = (txt: string) => compose(txt).flat().map(mod)

/** 从 from 起（向下取整到分钟）检查：片段首尾相接，且前一段的末尾姿态 == 后一段的开头姿态 */
function checkContinuity(s: Scheduler, from: number, minutes: number) {
  const first = Math.floor(from / 60_000) * 60_000
  for (let m = 0; m < minutes; m++) {
    const m0 = first + m * 60_000
    const segs = s.segments(m0)
    expect(segs[0].start).toBe(m0)
    expect(segs[segs.length - 1].end).toBe(m0 + 60_000)
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i], b = segs[i + 1] ?? s.segments(m0 + 60_000)[0]
      expect(b.start).toBe(a.end)
      if (b.start <= from) continue
      expect(poseAt(a, a.end)).toEqual(poseAt(b, b.start))
    }
  }
}

describe('glyphs', () => {
  it('temperature formats', () => {
    expect(tempText(18.4)).toBe('18°C')
    expect(tempText(5)).toBe(' 5°C')
    expect(tempText(-5)).toBe('-5°C')
    expect(tempText(-12)).toBe('-12°')
    expect(tempText(103)).toBe('103°')
  })
})

describe('scheduler', () => {
  const base = new Date(2026, 9, 10, 8, 55, 0).getTime()

  it('every minute lands exactly on the new time at :00', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => 18 })
    for (let m = 0; m < 70; m++) {
      const t = base + m * 60_000
      expect(poseAt(s.at(t), t)).toEqual(flat(new Date(t).toTimeString().slice(0, 5).replace(':', '')))
    }
  })

  it('segments are continuous across takeover and hour edge', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => -3 })
    checkContinuity(s, base, 70)
  })

  it('takeover shows date then temperature', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => 18 })
    const m0 = new Date(2026, 9, 10, 9, 10, 0).getTime()
    expect(poseAt(s.at(m0 + 20_000), m0 + 20_000)).toEqual(flat('1010'))
    expect(poseAt(s.at(m0 + 35_000), m0 + 35_000)).toEqual(flat('18°C'))
  })

  it('tap trigger keeps continuity, refused near transition', () => {
    const s = new Scheduler({ takeoverEvery: () => 0, temperature: () => 18 })
    const m0 = new Date(2026, 9, 10, 9, 3, 0).getTime()
    expect(s.trigger(m0 + 2_000)).toBe(true)
    checkContinuity(s, m0, 2)
    expect(poseAt(s.at(m0 + 10_000), m0 + 10_000)).toEqual(flat('1010'))
    const m1 = m0 + 60_000
    expect(s.trigger(m1 + 20_000)).toBe(false)
  })

  it('intro spins in without breaking continuity', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => null })
    const t = new Date(2026, 9, 10, 9, 4, 5).getTime()
    expect(s.intro(t, compose('    '))).toBe(true)
    expect(poseAt(s.at(t), t)).toEqual(flat('    '))
    expect(poseAt(s.at(t + 4_600), t + 4_600)).toEqual(flat('0904'))
    checkContinuity(s, t, 2)
  })
})
