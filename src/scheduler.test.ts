import { describe, expect, it } from 'vitest'
import { compose, isBlank, tempText, type Hands } from './glyphs'
import { GRAND } from './choreo'
import { Scheduler, sample, type Segment } from './scheduler'

const mod = (a: number) => ((Math.round(a) % 360) + 360) % 360
const poseAt = (seg: Segment, t: number) => { const o = new Float32Array(48); sample(seg, t, o); return [...o].map(mod) }
const flat = (txt: string) => compose(txt).flat().map(mod)
const lensAt = (seg: Segment, t: number) => { const o = new Float32Array(48), l = new Float32Array(24); sample(seg, t, o, l); return [...l] }
/** 每格的期望长度：空格 0，其余 1 */
const shown = (txt: string) => compose(txt).map((h) => (isBlank(h) ? 0 : 1))
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5))

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
      close(lensAt(a, a.end), lensAt(b, b.start))
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

  const handsAt = (seg: Segment, t: number): Hands[] => { const o = new Float32Array(48); sample(seg, t, o); return Array.from({ length: 24 }, (_, i) => [o[i * 2], o[i * 2 + 1]] as Hands) }

  it('tap cycles time → date → temp → time right away, even mid-transition', () => {
    for (const off of [2_000, 30_000, 45_000, 59_000]) {
      const s = new Scheduler({ takeoverEvery: () => 0, temperature: () => 18 })
      const t = new Date(2026, 9, 10, 9, 3, 0).getTime() + off
      const kind = s.at(t).kind
      expect(s.tap(t, handsAt(s.at(t), t))).toBe(true)
      expect(s.at(t + 6_000).kind).toBe(kind === 'time' ? 'date' : 'temp')
      const t2 = t + 7_000
      expect(s.tap(t2, handsAt(s.at(t2), t2))).toBe(true)
      expect(s.at(t2 + 6_000).kind).toBe('temp')
      const t3 = t2 + 7_000
      expect(s.tap(t3, handsAt(s.at(t3), t3))).toBe(true)
      expect(s.at(t3 + 1).type).toBe('move')
      checkContinuity(s, t, 3)
    }
  })

  it('intro spins in without breaking continuity', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => null })
    const t = new Date(2026, 9, 10, 9, 4, 5).getTime()
    expect(s.intro(t, compose('    '))).toBe(true)
    expect(poseAt(s.at(t), t)).toEqual(flat('    '))
    // 先跳一段编舞，十几秒后才落成时间
    expect(poseAt(s.at(t + 5_000), t + 5_000)).not.toEqual(flat('0904'))
    expect(poseAt(s.at(t + 14_600), t + 14_600)).toEqual(flat('0904'))
    checkContinuity(s, t, 2)
    // 开场从空盘长出
    expect(lensAt(s.at(t), t)).toEqual(new Array(24).fill(0))
  })
})

describe('intro near minute edge', () => {
  it('spans into the next minute and lands on the next time', () => {
    const s = new Scheduler({ takeoverEvery: () => 0, temperature: () => null })
    const t = new Date(2026, 9, 10, 9, 4, 38).getTime()
    expect(s.intro(t, compose('    '))).toBe(true)
    expect(poseAt(s.at(t), t)).toEqual(flat('    '))
    expect(poseAt(s.at(t + 23_000), t + 23_000)).toEqual(flat('0905'))
    checkContinuity(s, t, 3)
  })

  it('late in :59 the intro replaces the hour show and lands on the hour', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => 7 })
    const t = new Date(2026, 9, 10, 9, 59, 15).getTime()
    expect(s.intro(t, compose('    '))).toBe(true)
    expect(poseAt(s.at(t + 15_000), t + 15_000)).not.toEqual(flat("0959"))
    expect(poseAt(s.at(t + 45_200), t + 45_200)).toEqual(flat("1000"))
    checkContinuity(s, t, 3)
  })
})

describe('blank hands retract', () => {
  it('blank cells retract as soon as their own digit lands', () => {
    const s = new Scheduler({ takeoverEvery: () => 0, temperature: () => null })
    const m0 = new Date(2026, 9, 10, 11, 17, 0).getTime() // 1117：三个 1，各有 3 个空格
    // 第一位数字先落定，整块板落定（:00）时它的空格已经收好
    const first = lensAt(s.at(m0), m0)
    compose('1117').forEach((h, i) => { if (i % 8 < 2 && isBlank(h)) expect(first[i]).toBe(0) })
    // 落定后半秒内全部收完，循环随即停下
    expect(lensAt(s.at(m0 + 500), m0 + 500)).toEqual(shown('1117'))
    expect(sample(s.at(m0 + 500), m0 + 500, new Float32Array(48), new Float32Array(24))).toBe(false)
  })

  it('cells blank on both sides of a quick swap stay hidden', () => {
    const s = new Scheduler({ takeoverEvery: () => 10, temperature: () => 5 })
    const m0 = new Date(2026, 9, 1, 9, 10, 0).getTime() // 日期 1001 → 温度 " 5°C"
    const swap = s.segments(m0).find((g) => g.type === 'move' && g.kind === 'temp')!
    const from = compose('1001'), to = compose(' 5°C')
    for (const t of [0.1, 0.5, 0.9]) {
      const l = lensAt(swap, swap.start + t * (swap.end - swap.start))
      from.forEach((h, i) => { if (isBlank(h) && isBlank(to[i])) expect(l[i]).toBe(0) })
    }
    checkContinuity(s, m0, 1)
  })
})

describe('debug switching', () => {
  const opts = { takeoverEvery: () => 10, temperature: () => 21 }
  const starts = [0, 15_000, 40_000, 44_000, 55_000]

  it('show date / temp right away and return to time, at any moment', () => {
    for (const kind of ['date', 'temp'] as const)
      for (const off of starts) {
        const s = new Scheduler(opts)
        const t = new Date(2026, 9, 11, 14, 37).getTime() + off
        const from = compose('1437')
        expect(s.show(t, from, kind)).toBe(true)
        expect(s.at(t + 6_000).kind).toBe(kind)
        checkContinuity(s, t, 4)
      }
  })

  it('play any choreography right away, including across the hour', () => {
    for (const off of starts) {
      const s = new Scheduler(opts)
      const t = new Date(2026, 9, 11, 14, 59).getTime() + off
      expect(s.land(t, compose('1459'), GRAND, 40_000)).toBe(true)
      expect(s.at(t + 1).type).toBe('move')
      checkContinuity(s, t, 4)
    }
  })
})
