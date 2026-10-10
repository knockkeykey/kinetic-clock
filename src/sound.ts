// 合成机械声：过渡时一层很轻的电机嗡声，落定时一下细微的咔哒

let ctx: AudioContext | null = null
let master: GainNode | null = null

export function unlock() {
  if (ctx) { void ctx.resume(); return }
  ctx = new AudioContext()
  master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)
}

function noise(c: AudioContext, sec: number) {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * sec), c.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const s = c.createBufferSource()
  s.buffer = b
  return s
}

/** 转动嗡声，持续 sec 秒，首尾淡入淡出 */
export function whirr(sec: number) {
  if (!ctx || !master || ctx.state !== 'running') return
  const t = ctx.currentTime
  const src = noise(ctx, sec)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 900
  bp.Q.value = 6
  // 步进电机的细微颗粒感
  const lfo = ctx.createOscillator()
  const lfoGain = ctx.createGain()
  lfo.frequency.value = 38
  lfoGain.gain.value = 0.004
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.012, t + Math.min(2, sec / 4))
  g.gain.setValueAtTime(0.012, t + sec - Math.min(2, sec / 4))
  g.gain.linearRampToValueAtTime(0, t + sec)
  lfo.connect(lfoGain).connect(g.gain)
  src.connect(bp).connect(g).connect(master)
  src.start(t)
  lfo.start(t)
  src.stop(t + sec)
  lfo.stop(t + sec)
}

/** 落定的咔哒 */
export function click() {
  if (!ctx || !master || ctx.state !== 'running') return
  const t = ctx.currentTime
  const src = noise(ctx, 0.04)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 2400
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.05, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035)
  src.connect(hp).connect(g).connect(master)
  src.start(t)
}
