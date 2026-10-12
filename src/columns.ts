import { COLS, ROWS } from './glyphs'

/** 等第一列三只钟的指针全部收完，再隐藏钟盘。 */
export function firstColumnUnused(lens: ArrayLike<number>): boolean {
  return Array.from({ length: ROWS }, (_, r) => r * COLS).every((i) => lens[i] === 0)
}
