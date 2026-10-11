// 合成时钟滴答声：每秒一下，奇偶秒音高略不同（滴 / 答）

let ctx: AudioContext | null = null
let master: GainNode | null = null

export function unlock(): Promise<void> {
  if (ctx) return ctx.resume()
  // iOS 静音键默认会静掉 Web Audio，声明为播放类会话（Safari 17+）
  const nav = navigator as Navigator & { audioSession?: { type: string } }
  if (nav.audioSession) nav.audioSession.type = 'playback'
  ctx = new AudioContext()
  master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)
  return ctx.resume()
}

function noise(c: AudioContext, sec: number) {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * sec), c.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const s = c.createBufferSource()
  s.buffer = b
  return s
}

/** 一下滴答：短促的木质敲击，tock 为 true 时音高稍低 */
export function tick(tock = false) {
  if (!ctx || !master || ctx.state !== 'running') return
  const t = ctx.currentTime
  const f = tock ? 1500 : 1900

  // 擒纵轮的敲击瞬态
  const src = noise(ctx, 0.03)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = f * 2
  bp.Q.value = 3
  const ng = ctx.createGain()
  ng.gain.setValueAtTime(0.5, t)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025)
  src.connect(bp).connect(ng).connect(master)
  src.start(t)

  // 表壳的短共鸣
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = f
  const og = ctx.createGain()
  og.gain.setValueAtTime(0.18, t)
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
  osc.connect(og).connect(master)
  osc.start(t)
  osc.stop(t + 0.06)
}
