// 配色：昼夜两套 + 按节气的极淡色调

export type RGB = [number, number, number]

export interface Palette {
  bg: RGB
  hand: RGB
  shadow: number
  text: RGB
}

const DAY: Palette = { bg: [0.925, 0.922, 0.914], hand: [0.07, 0.07, 0.075], shadow: 1, text: [0.42, 0.41, 0.4] }
const NIGHT: Palette = { bg: [0.085, 0.086, 0.09], hand: [0.86, 0.82, 0.74], shadow: 0.55, text: [0.5, 0.48, 0.45] }

// 色调锚点：立春偏暖粉、夏至偏绿、立秋偏琥珀、冬至偏冷蓝（日序）
const SEASON: [number, RGB][] = [
  [35, [1.0, 0.62, 0.58]],
  [172, [0.62, 0.9, 0.62]],
  [220, [1.0, 0.78, 0.45]],
  [356, [0.55, 0.7, 1.0]],
]
const TINT = 0.035

function dayOfYear(d: Date) {
  return (d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000
}

export function seasonTint(d: Date): RGB {
  const x = dayOfYear(d)
  for (let i = 0; i < SEASON.length; i++) {
    const [d0, c0] = SEASON[i]
    const [d1raw, c1] = SEASON[(i + 1) % SEASON.length]
    const d1 = d1raw <= d0 ? d1raw + 365 : d1raw
    const xx = x < d0 ? x + 365 : x
    if (xx >= d0 && xx < d1) {
      const t = (xx - d0) / (d1 - d0)
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t) as RGB
    }
  }
  return SEASON[0][1]
}

const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i] - v) * t) as RGB

/** night ∈ [0,1]，用于昼夜渐变 */
export function palette(night: number, tint: RGB): Palette {
  const bgDay = mix(DAY.bg, mix(DAY.bg, tint, 1), TINT)
  const bgNight = mix(NIGHT.bg, mix(NIGHT.bg, tint, 1), TINT * 0.6)
  return {
    bg: mix(bgDay, bgNight, night),
    hand: mix(DAY.hand, NIGHT.hand, night),
    shadow: DAY.shadow + (NIGHT.shadow - DAY.shadow) * night,
    text: mix(DAY.text, NIGHT.text, night),
  }
}

export const css = (c: RGB, a = 1) => `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${a})`
