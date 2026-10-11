// 角度约定：0° 指向正上，顺时针为正。每个钟两根等长指针 [a, b]。
// 一个字形占 2 列 × 3 行，按行优先存放：[左上, 右上, 左中, 右中, 左下, 右下]

export type Hands = [number, number]
export type Glyph = Hands[]

const U = 0, R = 90, D = 180, L = 270
/** 空格姿态：两根都指向左下 */
export const IDLE: Hands = [225, 225]
const E = IDLE
/** 这一格不属于任何笔画（字形里填的是 E）。真实笔画不会两根都落在 225°，所以按值判断即可 */
export const isBlank = (h: Hands) => h[0] === IDLE[0] && h[1] === IDLE[1]

export const GLYPHS: Record<string, Glyph> = {
  '0': [[R, D], [L, D], [U, D], [U, D], [U, R], [U, L]],
  '1': [E, [D, D], E, [U, D], E, [U, U]],
  '2': [[R, R], [L, D], [R, D], [U, L], [U, R], [L, L]],
  '3': [[R, R], [L, D], [R, R], [U, L], [R, R], [U, L]],
  '4': [[D, D], [D, D], [U, R], [U, L], E, [U, U]],
  '5': [[R, D], [L, L], [U, R], [L, D], [R, R], [U, L]],
  '6': [[R, D], [L, L], [U, D], [L, D], [U, R], [U, L]],
  '7': [[R, R], [L, D], E, [U, D], E, [U, U]],
  '8': [[R, D], [L, D], [U, R], [U, L], [U, R], [U, L]],
  '9': [[R, D], [L, D], [U, R], [U, D], [R, R], [U, L]],
  '-': [E, E, [R, R], [L, L], E, E],
  '°': [[R, D], [L, D], [U, R], [U, L], E, E],
  C: [[R, D], [L, L], [U, D], E, [U, R], [L, L]],
  ' ': [E, E, E, E, E, E],
}

export const COLS = 8
export const ROWS = 3
export const CELLS = COLS * ROWS

/** 4 个字符 → 24 个钟（行优先，8 列 × 3 行） */
export function compose(text: string): Hands[] {
  const chars = [...text.padEnd(4, ' ')].slice(0, 4)
  const out: Hands[] = new Array(CELLS)
  chars.forEach((ch, gi) => {
    const g = GLYPHS[ch] ?? GLYPHS[' ']
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < 2; c++) out[r * COLS + gi * 2 + c] = [...g[r * 2 + c]] as Hands
  })
  return out
}

export const pad2 = (n: number) => String(n).padStart(2, '0')
export const timeText = (d: Date) => pad2(d.getHours()) + pad2(d.getMinutes())
export const dateText = (d: Date) => pad2(d.getMonth() + 1) + pad2(d.getDate())

/** 温度字形：18°C / -5°C / -12° / 5°C */
export function tempText(t: number): string {
  const n = Math.round(t)
  const s = String(n)
  if (s.length === 1) return ' ' + s + '°C'
  if (s.length === 2) return s + '°C'
  return (s + '°').slice(0, 4)
}
