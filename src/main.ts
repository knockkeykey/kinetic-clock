import '@fontsource/noto-serif-sc/300.css'
import './style.css'

import { compose } from './glyphs'
import { fetchWeather, isNight, lightDir, lunarLine, resolvePlace, weatherLine, type Place, type Weather } from './info'
import { createGL } from './render-gl'
import { create2D, type Layout, type Renderer } from './render'
import { Scheduler, sample, type Segment } from './scheduler'
import { save, settings } from './settings'
import * as sound from './sound'
import { css, palette, seasonTint } from './theme'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let canvas = $<HTMLCanvasElement>('c')
const lunarEl = $('lunar')
const weatherEl = $('weather')
const secBar = $('sec').firstElementChild as HTMLElement
const hint = $('hint')
const gear = $('gear')
const tools = $('tools')
const modeBtn = $('mode')
const panel = $<HTMLFormElement>('panel')

function makeRenderer(): Renderer {
  if (!new URLSearchParams(location.search).has('2d')) {
    const gl = createGL(canvas)
    if (gl) return gl
    // 拿过 WebGL 上下文的 canvas 不能再取 2D，换一块新的
    const fresh = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(fresh)
    canvas = fresh
  }
  return create2D(canvas)
}
const renderer = makeRenderer()

let place: Place | null = null
let weather: Weather | null = null

const sched = new Scheduler({
  takeoverEvery: () => settings.every,
  temperature: () => weather?.temp ?? null,
})

// ---------- 布局 ----------
let layout: Layout = { x: 0, y: 0, pitch: 0, w: 0, h: 0 }
let dpr = 1
let jitter: [number, number] = [0, 0]

function resize() {
  const W = innerWidth, H = innerHeight
  dpr = Math.min(devicePixelRatio || 1, 2)
  if (W * H * dpr * dpr > 9e6) dpr = Math.sqrt(9e6 / (W * H)) // 超大屏限制像素量
  canvas.width = Math.round(W * dpr)
  canvas.height = Math.round(H * dpr)
  // 避开刘海 / 圆角；手机屏幕小，网格占比更大
  const cs = getComputedStyle(document.documentElement)
  const inset = (k: string) => parseFloat(cs.getPropertyValue(k)) || 0
  const sl = inset('--sal'), sr = inset('--sar'), st = inset('--sat'), sb = inset('--sab')
  const aw = W - sl - sr, ah = H - st - sb
  const small = Math.min(W, H) < 600
  const pitch = Math.min((aw * (small ? 0.96 : 0.88)) / 8, (ah * (small ? 0.84 : 0.66)) / 3.55)
  const w = pitch * 8, h = pitch * 3
  layout = { x: sl + (aw - w) / 2 + jitter[0], y: st + (ah - pitch * 3.55) / 2 + jitter[1], pitch, w, h }
  const s = document.documentElement.style
  s.setProperty('--gx', `${layout.x}px`)
  s.setProperty('--gy', `${layout.y}px`)
  s.setProperty('--gw', `${w}px`)
  s.setProperty('--gh', `${h}px`)
  s.setProperty('--pitch', `${pitch}px`)
  s.setProperty('--fs', `${Math.max(11, Math.min(22, pitch * 0.12))}px`)
  requestDraw()
}

/** 防烧屏：每次过渡开始时整体挪动几个像素，藏在运动里 */
let lastJitter = 0
function maybeJitter(now: number) {
  if (now - lastJitter < 3 * 60_000) return
  lastJitter = now
  jitter = [Math.round((Math.random() * 2 - 1) * 4), Math.round((Math.random() * 2 - 1) * 3)]
  resize()
}

// ---------- 光源：太阳方位 + 手机陀螺仪 ----------
let tilt: [number, number] = [0, 0]
let tiltBase: [number, number] | null = null
let tiltDirty = false

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return
  const a = ((screen.orientation?.angle ?? 0) * Math.PI) / 180
  const v: [number, number] = [
    e.gamma * Math.cos(a) + e.beta * Math.sin(a),
    e.beta * Math.cos(a) - e.gamma * Math.sin(a),
  ]
  tiltBase ??= v
  // 基准缓慢跟随，倾斜后光影会慢慢回正
  tiltBase = [tiltBase[0] + (v[0] - tiltBase[0]) * 0.01, tiltBase[1] + (v[1] - tiltBase[1]) * 0.01]
  const nt: [number, number] = [
    Math.max(-1, Math.min(1, (v[0] - tiltBase[0]) / 20)),
    Math.max(-1, Math.min(1, (v[1] - tiltBase[1]) / 20)),
  ]
  if (Math.hypot(nt[0] - tilt[0], nt[1] - tilt[1]) > 0.01) { tilt = nt; tiltDirty = true; requestDraw() }
}

// ---------- 昼夜 ----------
function nightTarget(d: Date) {
  if (settings.theme === 'light') return 0
  if (settings.theme === 'dark') return 1
  return isNight(d, place) ? 1 : 0
}
let night = nightTarget(new Date())
let lastFrame = performance.now()
let lastCss = ''

// ---------- 主循环 ----------
const angles = new Float32Array(48)
const lens = new Float32Array(24).fill(1)
let raf = 0
let timer = 0
let current: Segment | null = null

function requestDraw() {
  if (raf) return
  clearTimeout(timer)
  raf = requestAnimationFrame(frame)
}

function onSegment(seg: Segment, now: number) {
  current = seg
  if (seg.type === 'move') maybeJitter(now)
  if (seg.start % 60_000 === 0) { syncSeconds(); updateBands() }
}

function frame(t: number) {
  raf = 0
  const now = Date.now()
  const d = new Date(now)
  const seg = sched.at(now)
  if (seg !== current) onSegment(seg, now)
  const moving = sample(seg, now, angles, lens)

  const dt = Math.min(200, t - lastFrame)
  lastFrame = t
  const nt = nightTarget(d)
  document.body.classList.toggle('dark', nt === 1)
  night += (nt - night) * Math.min(1, dt / 1200)
  if (Math.abs(nt - night) < 0.002) night = nt
  const pal = palette(night, seasonTint(d))
  const k = css(pal.bg) + css(pal.text)
  if (k !== lastCss) {
    lastCss = k
    const s = document.documentElement.style
    s.setProperty('--bg', css(pal.bg))
    s.setProperty('--text', css(pal.text))
  }

  const base = lightDir(d, place)
  const settling = renderer.draw({ angles, lens, layout, dpr, palette: pal, light: [base[0] + tilt[0] * 0.6, base[1] - tilt[1] * 0.45] })

  const busy = moving || night !== nt || tiltDirty || settling === true
  tiltDirty = false
  if (busy) raf = requestAnimationFrame(frame)
  else timer = window.setTimeout(requestDraw, Math.max(16, Math.min(seg.end - now, 30_000)))
}

// ---------- 滴答声 ----------
let tickTimer = 0
function scheduleTick() {
  clearTimeout(tickTimer)
  if (!settings.sound || document.hidden) return
  tickTimer = window.setTimeout(() => {
    sound.tick(Math.round(Date.now() / 1000) % 2 === 1)
    scheduleTick()
  }, 1000 - (Date.now() % 1000))
}

// ---------- 信息带 / 秒线 ----------
function updateBands() {
  lunarEl.textContent = lunarLine(new Date())
  weatherEl.textContent = weatherLine(weather, place)
}

function syncSeconds() {
  document.body.classList.toggle('no-sec', !settings.seconds)
  const ms = Date.now() % 60_000
  secBar.style.animation = 'none'
  void secBar.offsetWidth
  secBar.style.animation = ''
  secBar.style.setProperty('--sec-delay', `${-ms / 1000}s`)
}

async function refreshPlace() {
  place = await resolvePlace(settings.city)
  await refreshWeather()
}
async function refreshWeather() {
  if (place) weather = await fetchWeather(place)
  updateBands()
  requestDraw()
}

// ---------- 交互 ----------
let entered = false
let gearTimer = 0
let hintTimer = 0

function flashHint(text: string, ms = 1400) {
  hint.textContent = text
  hint.classList.remove('gone')
  clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => hint.classList.add('gone'), ms)
}

function showGear() {
  tools.classList.add('show')
  clearTimeout(gearTimer)
  gearTimer = window.setTimeout(() => tools.classList.remove('show'), 4000)
}

function enter() {
  entered = true
  hint.classList.add('gone')
  // iOS 的陀螺仪授权必须在用户手势里第一个发起，放在全屏之前
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined
  if (!window.isSecureContext) flashHint('需 HTTPS 才能使用陀螺仪和定位', 4000)
  else if (DOE?.requestPermission) {
    DOE.requestPermission()
      .then((r) => { if (r === 'granted') addEventListener('deviceorientation', onOrientation) })
      .catch(() => { /* 拒绝就只用太阳角度 */ })
  } else addEventListener('deviceorientation', onOrientation)
  const el = document.documentElement
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  if (settings.sound) void sound.unlock().then(scheduleTick)
}

addEventListener('pointerup', (e) => {
  if (!panel.hidden || (e.target as HTMLElement).closest('#tools, #panel')) return
  showGear()
  if (!entered) { enter(); return }
  if (sched.trigger(Date.now())) requestDraw()
  else flashHint('稍后再试')
})

// 日夜切换：在当前显示的反面固定下来，想恢复自动可在设置里选「随日出日落」
modeBtn.addEventListener('click', () => {
  const dark = nightTarget(new Date()) === 1
  save({ theme: dark ? 'light' : 'dark' })
  modeBtn.setAttribute('aria-label', dark ? '切换到夜间' : '切换到白天')
  showGear()
  requestDraw()
})

gear.addEventListener('click', () => {
  const f = panel.elements as unknown as Record<string, HTMLInputElement>
  f.city.value = settings.city
  f.theme.value = settings.theme
  f.every.value = String(settings.every)
  f.seconds.checked = settings.seconds
  f.sound.checked = settings.sound
  panel.hidden = false
  tools.classList.remove('show')
})

panel.addEventListener('submit', (e) => {
  e.preventDefault()
  const f = panel.elements as unknown as Record<string, HTMLInputElement>
  const city = f.city.value.trim()
  const cityChanged = city !== settings.city
  save({
    city, theme: f.theme.value as typeof settings.theme, every: Number(f.every.value),
    seconds: f.seconds.checked, sound: f.sound.checked,
  })
  panel.hidden = true
  if (settings.sound) void sound.unlock().then(scheduleTick)
  else clearTimeout(tickTimer)
  syncSeconds()
  if (cityChanged) void refreshPlace()
  requestDraw()
})

// 桌面端鼠标静止 3 秒隐藏
let idleTimer = 0
addEventListener('pointermove', () => {
  document.body.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 3000)
})

addEventListener('resize', resize)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); clearTimeout(tickTimer) }
  else { syncSeconds(); updateBands(); requestDraw(); scheduleTick() }
})

// ---------- 启动 ----------
resize()
updateBands()
syncSeconds()
sched.intro(Date.now(), compose('    '))
requestDraw()
void refreshPlace()
setInterval(() => void refreshWeather(), 30 * 60_000)
