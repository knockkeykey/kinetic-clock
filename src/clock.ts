// 虚拟时钟：调试时给真实时间加一个偏移，整个界面都按它走

let offset = 0

export const now = () => Date.now() + offset

/** 把当前时间设为 t（null 恢复真实时间）。偏移取整秒，秒针、滴答声仍与真实秒对齐 */
export function setTime(t: number | null) {
  offset = t === null ? 0 : Math.round((t - Date.now()) / 1000) * 1000
}

export const shifted = () => offset !== 0
