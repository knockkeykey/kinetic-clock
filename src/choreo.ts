// 编排：每种编排是一串阶段（stage），每个阶段对每个钟给出终点角度、方向和额外圈数。
// 整个过渡是 (进度 t, 钟位置, 起点, 终点) 的纯函数，任意时刻都能直接算出角度，不累积误差。

import { COLS, ROWS, isBlank, type Hands } from './glyphs'

export interface Cell { col: number; row: number }
type Dir = 1 | -1 | 0 // 1 顺时针，-1 逆时针，0 最短路径
type Target = (c: Cell, from: Hands, to: Hands) => Hands

interface Stage {
  /** 本阶段占整个过渡的比例 */
  w: number
  /** 终点姿态 */
  target: Target
  dir: (c: Cell) => [Dir, Dir]
  turns?: (c: Cell) => [number, number]
  /** 错峰：0..1，按钟位置给出的延迟比例 */
  delay?: (c: Cell) => number
  /** 延迟占本阶段的最大比例 */
  spread?: number
}

export interface Choreo {
  name: string
  stages: Stage[]
  /** 安静过渡：首尾都是空格的钟保持隐藏，不跟着出来 */
  quiet?: boolean
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t))
const mod = (a: number) => ((a % 360) + 360) % 360

/** 从 from 走到 target（模 360）的角度差，按方向并额外转 turns 圈 */
function delta(from: number, target: number, dir: Dir, turns: number): number {
  let d = mod(target - from)
  if (dir === 1) return d + 360 * turns
  if (dir === -1) return (d === 0 ? 0 : d - 360) - 360 * turns
  if (d > 180) d -= 360
  return d + Math.sign(d || 1) * 360 * turns
}

const colN = (c: Cell) => c.col / (COLS - 1)
const centerDist = (c: Cell) => Math.abs(c.col - (COLS - 1) / 2) / ((COLS - 1) / 2)
const left = (c: Cell) => c.col < COLS / 2
const CX = (COLS - 1) / 2, CY = (ROWS - 1) / 2
/** 离面板中心的距离，0..1 */
const radial = (c: Cell) => Math.hypot(c.col - CX, c.row - CY) / Math.hypot(CX, CY)
/** 从面板中心指向该钟的角度（0° 正上，顺时针） */
const outward = (c: Cell) => mod((Math.atan2(c.col - CX, -(c.row - CY)) * 180) / Math.PI)
const odd = (c: Cell) => (c.col + c.row) % 2 === 1

const final: Target = (_c, _f, to) => to
const pose = (a: number, b: number): Target => () => [a, b]

/** 落定：A 顺时针 B 逆时针，按数字依次错峰 */
const settle = (w: number, turns = 1): Stage => ({
  w, target: final, dir: () => [1, -1], turns: () => [turns, turns],
  delay: (c) => Math.floor(c.col / 2) / 3, spread: 0.3,
})

export const CHOREOS: Choreo[] = [
  {
    // 所有指针并成同一道斜线「/」，整体缓慢旋转，再散开成数字
    name: 'diagonal',
    stages: [
      { w: 0.3, target: pose(45, 225), dir: () => [1, -1], delay: colN, spread: 0.35 },
      { w: 0.35, target: pose(45 + 180, 225 + 180), dir: () => [1, 1] },
      settle(0.35),
    ],
  },
  {
    // 先竖直对齐，再从左到右按列推开一道波浪
    name: 'wave',
    stages: [
      { w: 0.25, target: pose(0, 180), dir: () => [0, 0] },
      { w: 0.4, target: pose(0, 180), dir: () => [1, 1], turns: () => [1, 1], delay: colN, spread: 0.55 },
      settle(0.35, 0),
    ],
  },
  {
    // 左右镜像的「< >」折线，左半顺时针、右半逆时针，从中心向外演化
    name: 'mirror',
    stages: [
      { w: 0.25, target: (c) => (left(c) ? [315, 225] : [45, 135]), dir: () => [0, 0] },
      {
        w: 0.4,
        target: (c) => (left(c) ? [315 + 90, 225 + 90] : [45 - 90, 135 - 90]),
        dir: (c) => (left(c) ? [1, 1] : [-1, -1]),
        turns: () => [1, 1],
        delay: centerDist, spread: 0.4,
      },
      { w: 0.35, target: final, dir: (c) => (left(c) ? [1, -1] : [-1, 1]), delay: (c) => 1 - centerDist(c), spread: 0.3 },
    ],
  },
  {
    // 两根指针反向各自转两圈后直接落定
    name: 'counter',
    stages: [settle(1, 2)],
  },
  {
    // 所有指针从中心向外放射成星芒，由内向外一圈圈张开又合上
    name: 'starburst',
    stages: [
      { w: 0.25, target: (c) => [outward(c), outward(c)], dir: () => [0, 0], delay: radial, spread: 0.3 },
      { w: 0.4, target: (c) => [outward(c), outward(c)], dir: () => [1, -1], turns: () => [1, 1], delay: radial, spread: 0.5 },
      { w: 0.35, target: final, dir: () => [1, -1], delay: (c) => 1 - radial(c), spread: 0.3 },
    ],
  },
  {
    // 每列角度依次错开 22.5°，整面板像一条扭转的缎带一起旋转
    name: 'ribbon',
    stages: [
      { w: 0.25, target: (c) => [colN(c) * 157.5, colN(c) * 157.5 + 180], dir: () => [0, 0] },
      { w: 0.4, target: (c) => [colN(c) * 157.5 + 180, colN(c) * 157.5 + 360], dir: () => [1, 1], turns: () => [1, 1] },
      settle(0.35, 0),
    ],
  },
  {
    // 三行横线，上下两行顺时针、中间一行逆时针，像齿轮咬合
    name: 'gears',
    stages: [
      { w: 0.25, target: pose(90, 270), dir: () => [0, 0], delay: (c) => c.row / (ROWS - 1), spread: 0.3 },
      {
        w: 0.4, target: pose(90, 270),
        dir: (c) => (c.row % 2 ? [-1, -1] : [1, 1]), turns: () => [1, 1],
        delay: (c) => (c.row % 2 ? 1 - colN(c) : colN(c)), spread: 0.45,
      },
      settle(0.35, 0),
    ],
  },
  {
    // 棋盘格：相邻的钟朝相反方向转，斜线 / 与 \ 交替翻转
    name: 'checker',
    stages: [
      { w: 0.25, target: (c) => (odd(c) ? [135, 315] : [45, 225]), dir: () => [0, 0] },
      { w: 0.4, target: (c) => (odd(c) ? [45, 225] : [135, 315]), dir: (c) => (odd(c) ? [-1, -1] : [1, 1]), turns: () => [1, 1] },
      settle(0.35, 0),
    ],
  },
  {
    // 像秒针一样一格一格跳：竖线 → 横线 → 竖线 → 横线，每一步从左到右传过去
    name: 'tick',
    stages: [
      { w: 0.15, target: pose(0, 180), dir: () => [0, 0] },
      { w: 0.12, target: pose(90, 270), dir: () => [1, 1], delay: colN, spread: 0.5 },
      { w: 0.12, target: pose(180, 360), dir: () => [1, 1], delay: colN, spread: 0.5 },
      { w: 0.12, target: pose(270, 450), dir: () => [1, 1], delay: colN, spread: 0.5 },
      { w: 0.12, target: pose(360, 540), dir: () => [1, 1], delay: colN, spread: 0.5 },
      settle(0.37, 0),
    ],
  },
]

/** 整点大编排：斜线 → 波浪 → 镜像 → 落定 */
export const GRAND: Choreo = {
  name: 'grand',
  stages: [
    { w: 0.12, target: pose(45, 225), dir: () => [1, -1], delay: colN, spread: 0.35 },
    { w: 0.13, target: pose(225, 405), dir: () => [1, 1] },
    { w: 0.08, target: pose(0, 180), dir: () => [0, 0] },
    { w: 0.17, target: pose(0, 180), dir: () => [1, 1], turns: () => [1, 1], delay: colN, spread: 0.55 },
    { w: 0.08, target: (c) => (left(c) ? [315, 225] : [45, 135]), dir: () => [0, 0] },
    {
      w: 0.17, target: (c) => (left(c) ? [45, 315] : [-45, 45]),
      dir: (c) => (left(c) ? [1, 1] : [-1, -1]), turns: () => [1, 1], delay: centerDist, spread: 0.4,
    },
    settle(0.25),
  ],
}

/** 变身之间的短过渡 */
export const QUICK: Choreo = {
  name: 'quick',
  quiet: true,
  stages: [{ w: 1, target: final, dir: () => [1, -1], delay: colN, spread: 0.25 }],
}

/** 开场编舞：从收起的空盘长出指针，跳完一段再落成时间 */
export const INTROS: Choreo[] = [
  {
    // 从中心向外绽开成星芒 → 旋转一圈 → 收成斜线整体转半圈 → 落定
    name: 'intro-bloom',
    stages: [
      { w: 0.18, target: (c) => [outward(c), outward(c)], dir: () => [1, 1], delay: radial, spread: 0.5 },
      { w: 0.2, target: (c) => [outward(c), outward(c)], dir: () => [1, -1], turns: () => [1, 1], delay: radial, spread: 0.45 },
      { w: 0.12, target: pose(45, 225), dir: () => [0, 0], delay: (c) => 1 - radial(c), spread: 0.4 },
      { w: 0.18, target: pose(225, 405), dir: () => [1, 1] },
      settle(0.32),
    ],
  },
  {
    // 从左到右竖起一排 → 波浪 → 齿轮横线 → 落定
    name: 'intro-sweep',
    stages: [
      { w: 0.16, target: pose(0, 180), dir: () => [1, -1], delay: colN, spread: 0.55 },
      { w: 0.2, target: pose(0, 180), dir: () => [1, 1], turns: () => [1, 1], delay: colN, spread: 0.55 },
      { w: 0.1, target: pose(90, 270), dir: () => [1, 1] },
      {
        w: 0.22, target: pose(90, 270),
        dir: (c) => (c.row % 2 ? [-1, -1] : [1, 1]), turns: () => [1, 1],
        delay: (c) => (c.row % 2 ? 1 - colN(c) : colN(c)), spread: 0.45,
      },
      settle(0.32, 0),
    ],
  },
  {
    // 棋盘格斜线翻转 → 缎带旋转 → 镜像折线向外散开 → 落定
    name: 'intro-weave',
    stages: [
      { w: 0.16, target: (c) => (odd(c) ? [135, 315] : [45, 225]), dir: () => [1, -1], delay: (c) => c.row / (ROWS - 1), spread: 0.4 },
      { w: 0.18, target: (c) => (odd(c) ? [45, 225] : [135, 315]), dir: (c) => (odd(c) ? [-1, -1] : [1, 1]), turns: () => [1, 1] },
      { w: 0.1, target: (c) => [colN(c) * 157.5, colN(c) * 157.5 + 180], dir: () => [0, 0] },
      { w: 0.18, target: (c) => [colN(c) * 157.5 + 180, colN(c) * 157.5 + 360], dir: () => [1, 1], turns: () => [1, 1] },
      { w: 0.38, target: final, dir: (c) => (left(c) ? [1, -1] : [-1, 1]), delay: (c) => 1 - centerDist(c), spread: 0.35 },
    ],
  },
]

/**
 * 每个阶段每个钟的起止角度预先算好，求值时只做插值。
 * grow：起点是空格（指针已缩回）且本次过渡要露面的钟，过渡开头伸出来；
 * hidden：安静过渡里首尾都是空格的钟，全程不露面。
 */
export interface Plan { choreo: Choreo; keys: Hands[][]; to: Hands[]; grow: boolean[]; hidden: boolean[] }

/**
 * 空格指针收起：在该钟最后一段转动里就开始缩，正好在它落定那一刻收完；
 * 伸出：从该钟开始转动那一刻起慢慢长出来。两者都靠提前开始，而不是加快速度。
 */
export const RETRACT_MS = 1400
const GROW_MS = 1200

/** 相对落定时刻 ms 毫秒（负数为落定前）时，空格指针剩下的长度（1 → 0） */
export const retractLen = (ms: number) => 1 - ease(1 + ms / RETRACT_MS)

export function plan(choreo: Choreo, from: Hands[], to: Hands[]): Plan {
  const hidden = from.map((f, i) => !!choreo.quiet && isBlank(f) && isBlank(to[i]))
  const grow = from.map((f, i) => isBlank(f) && !hidden[i])
  const keys: Hands[][] = [from.map((h) => [...h] as Hands)]
  let prev = keys[0]
  for (const s of choreo.stages) {
    const next = prev.map((p, i) => {
      const c: Cell = { col: i % COLS, row: Math.floor(i / COLS) }
      const tg = s.target(c, from[i], to[i])
      const dir = s.dir(c)
      const tr = s.turns?.(c) ?? [0, 0]
      return [p[0] + delta(p[0], tg[0], dir[0], tr[0]), p[1] + delta(p[1], tg[1], dir[1], tr[1])] as Hands
    })
    keys.push(next)
    prev = next
  }
  return { choreo, keys, to, grow, hidden }
}

/** 每个钟在过渡里落定的时刻（0..1）：最后一段里它自己的转动结束时，与姿态无关 */
export function landTimes(choreo: Choreo): number[] {
  const { stages } = choreo
  const s = stages[stages.length - 1]
  const total = stages.reduce((a, x) => a + x.w, 0)
  const spread = s.delay ? s.spread ?? 0.3 : 0
  return Array.from({ length: COLS * ROWS }, (_, i) => {
    const c: Cell = { col: i % COLS, row: Math.floor(i / COLS) }
    const d = s.delay ? s.delay(c) * spread : 0
    // 局部进度到 d + (1 - spread) 时这一钟走完
    return Math.min(1, (total - s.w + s.w * (d + 1 - spread)) / total)
  })
}

/**
 * t ∈ [0,1] 时每个钟的指针长度（0..1）：
 * 伸出的钟从开始转动起慢慢长出来；终点是空格的钟在最后一段转动里缩回，落定时收完。
 * dur 为过渡总时长（毫秒），用来换算成真实时间。
 */
export function evaluateLen(p: Plan, t: number, dur: number, out: Float32Array) {
  const { stages } = p.choreo
  const s = stages[0]
  const total = stages.reduce((a, x) => a + x.w, 0)
  const spread = s.delay ? s.spread ?? 0.3 : 0
  const land = landTimes(p.choreo)
  for (let i = 0; i < p.grow.length; i++) {
    if (p.hidden[i]) { out[i] = 0; continue }
    let k = 1
    if (p.grow[i]) {
      const c: Cell = { col: i % COLS, row: Math.floor(i / COLS) }
      const begin = (s.delay ? s.delay(c) * spread : 0) * (s.w / total)
      k = ease(((t - begin) * dur) / GROW_MS)
    }
    if (isBlank(p.to[i])) k = Math.min(k, retractLen((t - land[i]) * dur))
    out[i] = k
  }
}

/** t ∈ [0,1] 时整个面板的角度 */
export function evaluate(p: Plan, t: number, out: Float32Array) {
  const { stages } = p.choreo
  let acc = 0
  let si = stages.length - 1
  for (let i = 0; i < stages.length; i++) {
    if (t < acc + stages[i].w || i === stages.length - 1) { si = i; break }
    acc += stages[i].w
  }
  const s = stages[si]
  const local = Math.min(1, Math.max(0, (t - acc) / s.w))
  const a = p.keys[si], b = p.keys[si + 1]
  const spread = s.delay ? s.spread ?? 0.3 : 0
  for (let i = 0; i < a.length; i++) {
    const c: Cell = { col: i % COLS, row: Math.floor(i / COLS) }
    const d = s.delay ? s.delay(c) * spread : 0
    const k = ease((local - d) / (1 - spread))
    out[i * 2] = a[i][0] + (b[i][0] - a[i][0]) * k
    out[i * 2 + 1] = a[i][1] + (b[i][1] - a[i][1]) * k
  }
}
