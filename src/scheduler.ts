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

  /** 从 now 起替换当前静止片段的剩余部分 */
  private splice(now: number, make: (hold: Hold) => Segment[]): boolean {
    const m0 = Math.floor(now / MIN) * MIN
    const segs = this.segments(m0)
    const i = segs.findIndex((s) => now >= s.start && now < s.end)
    if (i < 0 || segs[i].type !== 'hold') return false
    const hold = segs[i] as Hold
    const inserted = make(hold)
    if (!inserted.length) return false
    const head: Segment[] = now > hold.start ? [{ ...hold, end: now }] : []
    segs.splice(i, 1, ...head, ...inserted)
    return true
  }

  /** 轻点：播一遍"日期 → 温度"。过渡中或离下次过渡不足 25s 时返回 false */
  trigger(now: number): boolean {
    return this.splice(now, (hold) => {
      const left = hold.end - now
      if (hold.kind !== 'time' || left < 25 * S) return []
      const extra = this.extraPoses(new Date(now))
      const out: Segment[] = []
      let cursor = now
      let last = hold.pose
      const slot = 11 * S
      for (const e of extra) {
        const p = plan(QUICK, last, e.pose)
        out.push({ type: 'move', start: cursor, end: cursor + QUICK_MS, plan: p, kind: e.kind })
        out.push({ type: 'hold', start: cursor + QUICK_MS, end: cursor + slot, pose: e.pose, kind: e.kind, retractAt: retractAfter(QUICK, p.hidden, cursor, cursor + QUICK_MS) })
        cursor += slot
        last = e.pose
      }
      const room = hold.end - cursor
      if (room >= QUICK_MS + 3 * S) {
        const p = plan(QUICK, last, hold.pose)
        out.push({ type: 'move', start: cursor, end: cursor + QUICK_MS, plan: p, kind: 'time' })
        out.push({ ...hold, start: cursor + QUICK_MS, retractAt: retractAfter(QUICK, p.hidden, cursor, cursor + QUICK_MS) })
        last = hold.pose
      } else {
        // 时间不够回到时间，就把最后一个姿态延长到下一次过渡
        const tail = out[out.length - 1] as Hold
        tail.end = hold.end
      }
      // 紧随其后的过渡要从最后停住的姿态出发
      this.rebaseNextMove(now, hold.end, last)
      return out
    })
  }

  /**
   * 开场：从空盘先跳一段编舞，再落成时间。
   * 落点选在 now + ms 附近、某个"时间"静止片段里；不够放就顺延到下一个时间片段，必要时跨分钟。
   */
  intro(now: number, from: Hands[], ms = 14 * S, minMs = 9 * S): boolean {
    const choreo = INTROS[Math.floor(Math.random() * INTROS.length)]
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
    const span: [number, number] = [now, end]
    // 把 [now, end) 之间原有的片段换成开场编舞，按分钟边界切开
    for (let m = m0; m < end; m += MIN) {
      const segs = this.segments(m)
      const a = Math.max(now, m), b = Math.min(end, m + MIN)
      const kept: Segment[] = []
      for (const g of segs) {
        if (g.end <= a || g.start >= b) { kept.push(g); continue }
        if (g.start < a) kept.push({ ...g, end: a } as Segment)
        if (g.end > b) {
          const tail = { ...g, start: b } as Segment
          if (g === target) (tail as Hold).retractAt = retractAfter(choreo, p.hidden, now, end)
          kept.push(tail)
        }
      }
      kept.push({ type: 'move', start: a, end: b, plan: p, kind: 'time', span })
      kept.sort((x, y) => x.start - y.start)
      this.cache.set(m, kept)
    }
    return true
  }

  private rebaseNextMove(now: number, at: number, from: Hands[]) {
    const segs = this.segments(Math.floor(now / MIN) * MIN)
    const mv = segs.find((s) => s.type === 'move' && s.start === at) as Move | undefined
    if (mv) mv.plan = plan(mv.plan.choreo, from, mv.plan.to)
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
