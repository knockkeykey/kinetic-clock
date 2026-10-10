// 编排：每种编排是一串阶段（stage），每个阶段对每个钟给出终点角度、方向和额外圈数。
// 整个过渡是 (进度 t, 钟位置, 起点, 终点) 的纯函数，任意时刻都能直接算出角度，不累积误差。

import { COLS, ROWS, type Hands } from './glyphs'

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

export interface Choreo { name: string; stages: Stage[] }

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
  stages: [{ w: 1, target: final, dir: () => [1, -1], delay: colN, spread: 0.25 }],
}

/** 开场：从空格姿态旋入 */
export const INTRO: Choreo = {
  name: 'intro',
  stages: [{ w: 1, target: final, dir: () => [1, -1], turns: () => [1, 1], delay: (c) => (c.row * COLS + c.col) / (ROWS * COLS - 1), spread: 0.4 }],
}

/** 每个阶段每个钟的起止角度预先算好，求值时只做插值 */
export interface Plan { choreo: Choreo; keys: Hands[][] }

export function plan(choreo: Choreo, from: Hands[], to: Hands[]): Plan {
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
  return { choreo, keys }
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
