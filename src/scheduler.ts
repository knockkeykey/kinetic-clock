// 时间线：按分钟生成"静止 / 过渡"片段，全部由真实时间推导，不靠 setTimeout 链。
//  普通分钟   :00 落定时间 → :42 开始 18s 过渡 → 下一分钟 :00 落定
//  每 N 分钟  :15 日期 → :26 温度 → :42 从温度直接过渡到下一分钟
//  :59 分钟   :20 开始 40s 整点大编排

import { CHOREOS, GRAND, INTROS, QUICK, evaluate, evaluateLen, landTimes, plan, retractLen, type Choreo, type Plan } from './choreo'
import { compose, dateText, isBlank, tempText, timeText, type Hands } from './glyphs'

export type Kind = 'time' | 'date' | 'temp'

/** retractAt：每个空格钟的落定时刻（绝对时间，缩回在此刻收完）；-Infinity 表示早已藏好 */
export interface Hold { type: 'hold'; start: number; end: number; pose: Hands[]; kind: Kind; retractAt: number[] }
/** span：整段编舞的真实起止时间。跨分钟的编舞会拆成几段，共用同一个 plan */
export interface Move { type: 'move'; start: number; end: number; plan: Plan; kind: Kind; span?: [number, number] }
export type Segment = Hold | Move

const MIN = 60_000
const S = 1000
const QUICK_MS = 5 * S

/** 过渡 [start, end] 之后，各空格钟的落定时刻（安静过渡里一直藏着的记为 -Infinity） */
function retractAfter(choreo: Choreo, hidden: boolean[] | null, start: number, end: number): number[] {
  return landTimes(choreo).map((l, i) => (hidden?.[i] ? -Infinity : start + l * (end - start)))
}

export interface ScheduleOptions {
  /** 每多少分钟展示一次日期/温度，0 为关闭 */
  takeoverEvery: () => number
  temperature: () => number | null
}

export class Scheduler {
  private cache = new Map<number, Segment[]>()
  private lastChoreo = -1
  private choreoByMinute = new Map<number, number>()

  constructor(private opts: ScheduleOptions) {}

  private pickChoreo(m0: number): Choreo {
    let i = this.choreoByMinute.get(m0)
    if (i === undefined) {
      do i = Math.floor(Math.random() * CHOREOS.length)
      while (CHOREOS.length > 1 && i === this.lastChoreo)
      this.lastChoreo = i
      this.choreoByMinute.set(m0, i)
    }
    return CHOREOS[i]
  }

  /** 上一分钟末尾那段编舞过渡之后，各钟的落定时刻（只取编舞和时间，不必重建整分钟） */
  private prevLand(m0: number): number[] {
    const p0 = m0 - MIN
    if (new Date(p0).getMinutes() === 59) return retractAfter(GRAND, null, p0 + 20 * S, m0)
    return retractAfter(this.pickChoreo(p0), null, p0 + 42 * S, m0)
  }

  private build(m0: number): Segment[] {
    const now = new Date(m0)
    const landed = this.prevLand(m0)
    const timePose = compose(timeText(now))
    const nextTime = compose(timeText(new Date(m0 + MIN)))
    const isHourEdge = now.getMinutes() === 59
    const every = this.opts.takeoverEvery()
    const takeover = !isHourEdge && every > 0 && now.getMinutes() % every === 0
    const segs: Segment[] = []

    if (isHourEdge) {
      const t0 = m0 + 20 * S
      segs.push({ type: 'hold', start: m0, end: t0, pose: timePose, kind: 'time', retractAt: landed })
      segs.push({ type: 'move', start: t0, end: m0 + MIN, plan: plan(GRAND, timePose, nextTime), kind: 'time' })
      return segs
    }

    let cursor = m0
    let last = timePose
    if (takeover) {
      const extra = this.extraPoses(now)
      segs.push({ type: 'hold', start: m0, end: m0 + 15 * S, pose: timePose, kind: 'time', retractAt: landed })
      cursor = m0 + 15 * S
      const slot = (42 * S - 15 * S) / extra.length
      for (const e of extra) {
        const p = plan(QUICK, last, e.pose)
        segs.push({ type: 'move', start: cursor, end: cursor + QUICK_MS, plan: p, kind: e.kind })
        segs.push({ type: 'hold', start: cursor + QUICK_MS, end: cursor + slot, pose: e.pose, kind: e.kind, retractAt: retractAfter(QUICK, p.hidden, cursor, cursor + QUICK_MS) })
        cursor += slot
        last = e.pose
      }
    } else {
      segs.push({ type: 'hold', start: m0, end: m0 + 42 * S, pose: timePose, kind: 'time', retractAt: landed })
      cursor = m0 + 42 * S
    }
    segs.push({ type: 'move', start: cursor, end: m0 + MIN, plan: plan(this.pickChoreo(m0), last, nextTime), kind: 'time' })
    return segs
  }

  private extraPoses(d: Date): { kind: Kind; pose: Hands[] }[] {
    const out: { kind: Kind; pose: Hands[] }[] = [{ kind: 'date', pose: compose(dateText(d)) }]
    const t = this.opts.temperature()
    if (t !== null) out.push({ kind: 'temp', pose: compose(tempText(t)) })
    return out
  }

  segments(m0: number): Segment[] {
    let s = this.cache.get(m0)
    if (!s) {
      s = this.build(m0)
      this.cache.set(m0, s)
      for (const k of this.cache.keys()) if (k < m0 - 2 * MIN) this.cache.delete(k)
    }
    return s
  }

  at(now: number): Segment {
    const m0 = Math.floor(now / MIN) * MIN
    const segs = this.segments(m0)
    return segs.find((s) => now >= s.start && now < s.end) ?? segs[segs.length - 1]
  }

  /** 轻点：立刻切到下一个画面，时间 → 日期 → 温度 → 时间，任何时刻都生效 */
  tap(now: number, from: Hands[]): boolean {
    const kind = this.at(now).kind
    if (kind === 'time') return this.show(now, from, 'date')
    if (kind === 'date' && this.opts.temperature() !== null) return this.show(now, from, 'temp')
    return this.land(now, from, QUICK, QUICK_MS, 3 * S)
  }

  /** 清空时间线（调试改时间后重建） */
  reset() {
    this.cache.clear()
    this.choreoByMinute.clear()
    this.lastChoreo = -1
  }

  /** 截取片段的 [s, e) 部分；过渡片段保留原起止，进度不变 */
  private clip(g: Segment, s: number, e: number): Segment {
    return g.type === 'move' ? { ...g, start: s, end: e, span: g.span ?? [g.start, g.end] } : { ...g, start: s, end: e }
  }

  /** 把 [now, end) 之间原有的片段换成 insert，按分钟边界切开 */
  private cut(now: number, end: number, insert: Segment[]) {
    for (let m = Math.floor(now / MIN) * MIN; m < end; m += MIN) {
      const a = Math.max(now, m), b = Math.min(end, m + MIN)
      const kept: Segment[] = []
      for (const g of this.segments(m)) {
        if (g.end <= a || g.start >= b) { kept.push(g); continue }
        if (g.start < a) kept.push(this.clip(g, g.start, a))
        if (g.end > b) kept.push(this.clip(g, b, g.end))
      }
      for (const g of insert) {
        const s = Math.max(g.start, a), e = Math.min(g.end, b)
        if (s < e) kept.push(this.clip(g, s, e))
      }
      kept.sort((x, y) => x.start - y.start)
      this.cache.set(m, kept)
    }
  }

  /**
   * 从 from 跳一段 choreo，落成时间。
   * 落点选在 now + ms 附近、某个"时间"静止片段里；不够放就顺延到下一个时间片段，必要时跨分钟。
   */
  land(now: number, from: Hands[], choreo: Choreo, ms: number, minMs = ms): boolean {
    // 找落点：第一个能在 [now + minMs, hold.end - 500] 里落下的时间片段
    let target: Hold | null = null
    let end = 0
    const m0 = Math.floor(now / MIN) * MIN
    for (let m = m0; m <= m0 + 2 * MIN && !target; m += MIN) {
      for (const g of this.segments(m)) {
        if (g.type !== 'hold' || g.kind !== 'time' || g.end <= now) continue
        const lo = Math.max(g.start, now + minMs), hi = g.end - 500
        if (lo > hi) continue
        target = g
        end = Math.min(Math.max(now + ms, lo), hi)
        break
      }
    }
    if (!target) return false
    const p = plan(choreo, from, target.pose)
    this.cut(now, end, [{ type: 'move', start: now, end, plan: p, kind: 'time' }])
    const tail = this.segments(Math.floor(end / MIN) * MIN).find((g) => g.type === 'hold' && g.start === end) as Hold | undefined
    if (tail) tail.retractAt = retractAfter(choreo, p.hidden, now, end)
    return true
  }

  /** 开场：从空盘先跳一段编舞，再落成时间 */
  intro(now: number, from: Hands[], ms = 14 * S, minMs = 9 * S): boolean {
    return this.land(now, from, INTROS[Math.floor(Math.random() * INTROS.length)], ms, minMs)
  }

  /** 立刻切到日期 / 温度，停 holdMs 后回到时间。没有温度数据时返回 false */
  show(now: number, from: Hands[], kind: 'date' | 'temp', holdMs = 8 * S): boolean {
    const e = this.extraPoses(new Date(now)).find((x) => x.kind === kind)
    if (!e) return false
    const p = plan(QUICK, from, e.pose)
    const mid = now + QUICK_MS, end = mid + holdMs
    this.cut(now, end, [
      { type: 'move', start: now, end: mid, plan: p, kind },
      { type: 'hold', start: mid, end, pose: e.pose, kind, retractAt: retractAfter(QUICK, p.hidden, now, mid) },
    ])
    return this.land(end, e.pose, QUICK, QUICK_MS, 3 * S)
  }
}

/** 求某一时刻 48 个角度和 24 个指针长度；返回是否在运动（含空格指针缩回） */
export function sample(seg: Segment, now: number, out: Float32Array, lens?: Float32Array): boolean {
  if (seg.type === 'hold') {
    seg.pose.forEach((h, i) => { out[i * 2] = h[0]; out[i * 2 + 1] = h[1] })
    let moving = false
    seg.pose.forEach((h, i) => {
      if (!isBlank(h)) { if (lens) lens[i] = 1; return }
      const ms = now - seg.retractAt[i]
      if (lens) lens[i] = retractLen(ms)
      if (ms < 0) moving = true
    })
    return moving
  }
  const [a, b] = seg.span ?? [seg.start, seg.end]
  const t = Math.min(1, (now - a) / (b - a))
  evaluate(seg.plan, t, out)
  if (lens) evaluateLen(seg.plan, t, b - a, lens)
  return t < 1
}
