import '@fontsource/noto-serif-sc/300.css'
import './style.css'

import { CHOREOS, GRAND, INTROS, QUICK } from './choreo'
import * as clock from './clock'
import { firstColumnUnused } from './columns'
import { compose, type Hands } from './glyphs'
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
let drawLayout: Layout = layout
let dpr = 1
let jitter: [number, number] = [0, 0]
let firstColumnHidden = 0

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
  syncLayout()
  requestDraw()
}

/** 收起第一列时保留钟盘尺寸，剩余七列与信息带一起居中。 */
function syncLayout() {
  const { pitch } = layout
  const hidden = firstColumnHidden * firstColumnHidden * (3 - 2 * firstColumnHidden)
  const shift = hidden * pitch / 2
  const s = document.documentElement.style
  s.setProperty('--gx', `${layout.x + shift}px`)
  s.setProperty('--gy', `${layout.y}px`)
  s.setProperty('--gw', `${layout.w - hidden * pitch}px`)
  s.setProperty('--gh', `${layout.h}px`)
  s.setProperty('--pitch', `${pitch}px`)
  s.setProperty('--fs', `${Math.max(11, Math.min(22, pitch * 0.12))}px`)
  drawLayout = { ...layout, x: layout.x - shift }
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
let night = nightTarget(new Date(clock.now()))
let lastFrame = performance.now()
let lastCss = ''

// ---------- 主循环 ----------
const angles = new Float32Array(48)
const lens = new Float32Array(24).fill(1)
let raf = 0
let timer = 0
let current: Segment | null = null
/** 调试：空格里收起的指针也画出来；blankMix 0..1 跟着它渐变，指针慢慢伸出 / 缩回 */
let showBlanks = false
let blankMix = 0
const BLANK_MS = 1200

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
  const now = clock.now()
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

  const bt = showBlanks ? 1 : 0
  if (blankMix !== bt) {
    blankMix += Math.sign(bt - blankMix) * (dt / BLANK_MS)
    blankMix = Math.max(0, Math.min(1, blankMix))
  }
  if (blankMix > 0) {
    const k = 0.5 - 0.5 * Math.cos(Math.PI * blankMix)
    for (let i = 0; i < lens.length; i++) lens[i] += (1 - lens[i]) * k
  }

  // 编舞时恢复整列；静止画面只隐藏已经收完指针的空闲列。
  const columnTarget = settings.hideFirstColumn && !showBlanks && seg.type === 'hold' && firstColumnUnused(lens) ? 1 : 0
  if (firstColumnHidden !== columnTarget) {
    firstColumnHidden += Math.sign(columnTarget - firstColumnHidden) * dt / 650
    firstColumnHidden = Math.max(0, Math.min(1, firstColumnHidden))
    syncLayout()
  }

  const base = lightDir(d, place)
  const settling = renderer.draw({ angles, lens, firstColumnOpacity: 1 - firstColumnHidden, layout: drawLayout, dpr, palette: pal, light: [base[0] + tilt[0] * 0.6, base[1] - tilt[1] * 0.45] })

  const busy = moving || blankMix !== bt || firstColumnHidden !== columnTarget || night !== nt || tiltDirty || settling === true
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
  lunarEl.textContent = lunarLine(new Date(clock.now()))
  weatherEl.textContent = weatherLine(weather, place)
}

function syncSeconds() {
  document.body.classList.toggle('no-sec', !settings.seconds)
  const ms = clock.now() % 60_000
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
  if (sched.tap(clock.now(), currentPose())) { current = null; syncSeconds(); updateBands(); requestDraw() }
})

const fsBtn = $('fs')
function syncFs() { fsBtn.classList.toggle('on', !!document.fullscreenElement) }
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => flashHint('浏览器不支持全屏'))
  showGear()
})
document.addEventListener('fullscreenchange', syncFs)
if (!document.documentElement.requestFullscreen) fsBtn.hidden = true

// 日夜切换：在当前显示的反面固定下来，想恢复自动可在设置里选「随日出日落」
modeBtn.addEventListener('click', () => {
  const dark = nightTarget(new Date(clock.now())) === 1
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
  f.hideFirstColumn.checked = settings.hideFirstColumn
  f.debug.checked = settings.debug
  f.blanks.checked = showBlanks
  debugBox.hidden = !settings.debug
  if (settings.debug) f.at.value = localInput(clock.now())
  panel.hidden = false
  fitPanel()
  tools.classList.remove('show')
})

panel.addEventListener('submit', (e) => {
  e.preventDefault()
  const f = panel.elements as unknown as Record<string, HTMLInputElement>
  const city = f.city.value.trim()
  const cityChanged = city !== settings.city
  save({
    city, theme: f.theme.value as typeof settings.theme, every: Number(f.every.value),
    seconds: f.seconds.checked, sound: f.sound.checked, debug: f.debug.checked,
    hideFirstColumn: f.hideFirstColumn.checked,
  })
  panel.hidden = true
  if (!settings.debug) showBlanks = false
  // 关掉调试模式时回到真实时间
  if (!settings.debug && clock.shifted()) {
    const from = currentPose()
    clock.setTime(null)
    sched.reset()
    sched.land(clock.now(), from, QUICK, 3_000, 1_500)
    current = null
    updateBands()
  }
  if (settings.sound) void sound.unlock().then(scheduleTick)
  else clearTimeout(tickTimer)
  syncSeconds()
  if (cityChanged) void refreshPlace()
  requestDraw()
})

// ---------- 调试 ----------
const debugBox = $<HTMLFieldSetElement>('dbg')
const dbg = panel.elements as unknown as Record<string, HTMLInputElement & HTMLSelectElement>
const ALL = [...CHOREOS, GRAND, ...INTROS]
/** 各编舞平时的时长 */
const choreoMs = (name: string) => (name === 'grand' ? 40_000 : name.startsWith('intro') ? 14_000 : 18_000)
dbg.choreo.innerHTML = ALL.map((c) => `<option value="${c.name}">${c.name}</option>`).join('')

const p2 = (n: number) => String(n).padStart(2, '0')
function localInput(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 当前画面上的姿态，作为立刻切换的起点 */
function currentPose(): Hands[] {
  sample(sched.at(clock.now()), clock.now(), angles, lens)
  return Array.from({ length: 24 }, (_, i) => [angles[i * 2], angles[i * 2 + 1]] as Hands)
}

/** 关面板、刷新画面，切换结果马上可见 */
function applied(ok: boolean, fail = '稍后再试') {
  panel.hidden = true
  current = null
  if (!ok) flashHint(fail)
  syncSeconds()
  updateBands()
  requestDraw()
}

dbg.debug.addEventListener('change', () => { debugBox.hidden = !dbg.debug.checked; if (dbg.debug.checked) dbg.at.value = localInput(clock.now()); fitPanel() })

dbg.blanks.addEventListener('change', () => { showBlanks = dbg.blanks.checked; requestDraw() })

// 设置窗口：仅拖动顶部把手，内容区域保留触摸滚动。
const panelHandle = $('panel-handle')
let drag: { id: number; x: number; y: number; px: number; py: number } | null = null
let panelPos: [number, number] = [0, 0]
function placePanel(x: number, y: number) {
  const v = visualViewport
  const width = v?.width ?? innerWidth, height = v?.height ?? innerHeight
  const vx = v?.offsetLeft ?? 0, vy = v?.offsetTop ?? 0
  const cs = getComputedStyle(document.documentElement)
  const inset = (k: string) => 16 + (parseFloat(cs.getPropertyValue(k)) || 0)
  const r = panel.getBoundingClientRect()
  const mx = (width - r.width) / 2, my = (height - r.height) / 2
  panelPos = [Math.max(inset('--sal') - mx, Math.min(mx - inset('--sar'), x)), Math.max(inset('--sat') - my, Math.min(my - inset('--sab'), y))]
  panel.style.setProperty('--vx', `${vx}px`)
  panel.style.setProperty('--vy', `${vy}px`)
  panel.style.setProperty('--px', `${panelPos[0]}px`)
  panel.style.setProperty('--py', `${panelPos[1]}px`)
}
function fitPanel() {
  const v = visualViewport
  panel.style.setProperty('--vw', `${v?.width ?? innerWidth}px`)
  panel.style.setProperty('--vh', `${v?.height ?? innerHeight}px`)
  if (!panel.hidden) placePanel(...panelPos)
}
panelHandle.addEventListener('pointerdown', (e) => {
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, px: panelPos[0], py: panelPos[1] }
  panelHandle.setPointerCapture(e.pointerId)
  panel.classList.add('dragging')
})
panelHandle.addEventListener('pointermove', (e) => {
  if (drag?.id === e.pointerId) placePanel(drag.px + e.clientX - drag.x, drag.py + e.clientY - drag.y)
})
const endDrag = (e: PointerEvent) => { if (drag?.id !== e.pointerId) return; drag = null; panel.classList.remove('dragging') }
panelHandle.addEventListener('pointerup', endDrag)
panelHandle.addEventListener('pointercancel', endDrag)
addEventListener('resize', fitPanel)
visualViewport?.addEventListener('resize', fitPanel)
visualViewport?.addEventListener('scroll', fitPanel)

$('dbg-set').addEventListener('click', () => {
  const t = new Date(dbg.at.value).getTime()
  if (Number.isNaN(t)) { flashHint('时间格式不对'); return }
  const from = currentPose()
  clock.setTime(t)
  sched.reset()
  applied(sched.land(clock.now(), from, QUICK, 3_000, 1_500))
})

$('dbg-real').addEventListener('click', () => {
  const from = currentPose()
  clock.setTime(null)
  sched.reset()
  applied(sched.land(clock.now(), from, QUICK, 3_000, 1_500))
})

debugBox.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.show as 'time' | 'date' | 'temp'
  const from = currentPose()
  const ok = kind === 'time' ? sched.land(clock.now(), from, QUICK, 3_000, 1_500) : sched.show(clock.now(), from, kind)
  applied(ok, kind === 'temp' && !weather ? '还没有温度数据' : '稍后再试')
}))

$('dbg-play').addEventListener('click', () => {
  const c = ALL.find((x) => x.name === dbg.choreo.value)!
  applied(sched.land(clock.now(), currentPose(), c, choreoMs(c.name)))
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
sched.intro(clock.now(), compose('    '))
requestDraw()
void refreshPlace()
setInterval(() => void refreshWeather(), 30 * 60_000)
