// 设置：localStorage 持久化，URL 参数临时覆盖（?city=上海&sound=1&theme=dark&every=10&seconds=1&debug=1）

export interface Settings {
  city: string
  sound: boolean
  theme: 'auto' | 'light' | 'dark'
  every: number
  seconds: boolean
  debug: boolean
}

const KEY = 'kc.settings'
const DEFAULTS: Settings = { city: '', sound: false, theme: 'auto', every: 10, seconds: false, debug: false }

function fromURL(): Partial<Settings> {
  const q = new URLSearchParams(location.search)
  const o: Partial<Settings> = {}
  if (q.has('city')) o.city = q.get('city')!.trim()
  if (q.has('sound')) o.sound = q.get('sound') === '1'
  const t = q.get('theme')
  if (t === 'auto' || t === 'light' || t === 'dark') o.theme = t
  if (q.has('every')) {
    const n = Number(q.get('every'))
    if ([0, 5, 10, 15, 30].includes(n)) o.every = n
  }
  if (q.has('seconds')) o.seconds = q.get('seconds') === '1'
  if (q.has('debug')) o.debug = q.get('debug') === '1'
  return o
}

function stored(): Partial<Settings> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

export const settings: Settings = { ...DEFAULTS, ...stored(), ...fromURL() }

export function save(patch: Partial<Settings>) {
  Object.assign(settings, patch)
  localStorage.setItem(KEY, JSON.stringify({ ...stored(), ...patch }))
}
