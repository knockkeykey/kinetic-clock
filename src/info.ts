// 信息：农历 / 节气 / 生肖（离线），位置 / 天气（Open-Meteo），日出日落与光源（suncalc）

import { Solar } from 'lunar-javascript'
import SunCalc from 'suncalc'

export interface Place { lat: number; lon: number; name: string }
export interface Weather { temp: number; code: number; max: number; min: number; at: number }

export function lunarLine(d: Date): string {
  const l = Solar.fromDate(d).getLunar()
  const year = `${l.getYearInGanZhi()}${l.getYearShengXiao()}年`
  const day = `${l.getMonthInChinese()}月${l.getDayInChinese()}`
  const cur = l.getCurrentJieQi()
  let term: string
  if (cur) term = `今日${cur.getName()}`
  else {
    const next = l.getNextJieQi(true)
    const s = next.getSolar()
    const target = new Date(s.getYear(), s.getMonth() - 1, s.getDay())
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const days = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    term = `距${next.getName()} ${days} 天`
  }
  return `${year} · ${day} · ${term}`
}

const WMO: [number[], string][] = [
  [[0], '晴'], [[1], '晴间多云'], [[2], '多云'], [[3], '阴'],
  [[45, 48], '雾'], [[51, 53, 55, 56, 57], '毛毛雨'],
  [[61, 63, 80, 81], '雨'], [[65, 82], '大雨'], [[66, 67], '冻雨'],
  [[71, 73, 77, 85], '雪'], [[75, 86], '大雪'], [[95, 96, 99], '雷阵雨'],
]
export const weatherName = (code: number) => WMO.find(([c]) => c.includes(code))?.[1] ?? ''

export function weatherLine(w: Weather | null, p: Place | null): string {
  if (!w) return p?.name ?? ''
  const parts = [`${Math.round(w.temp)}°`, weatherName(w.code), `${Math.round(w.min)}°/${Math.round(w.max)}°`]
  return parts.filter(Boolean).join(' ') + (p?.name ? ` · ${p.name}` : '')
}

const LS_PLACE = 'kc.place'
const LS_WEATHER = 'kc.weather'

function readJSON<T>(k: string): T | null {
  try { return JSON.parse(localStorage.getItem(k) ?? 'null') } catch { return null }
}

async function getJSON(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

async function geocodeCity(city: string): Promise<Place | null> {
  const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=${encodeURIComponent(city)}`)
  const r = j.results?.[0]
  return r ? { lat: r.latitude, lon: r.longitude, name: r.name } : null
}

async function reverseName(lat: number, lon: number): Promise<string> {
  try {
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`)
    return j.city || j.locality || j.principalSubdivision || ''
  } catch { return '' }
}

function geolocate(): Promise<GeolocationPosition> {
  return new Promise((res, rej) => {
    if (!navigator.geolocation || !window.isSecureContext) return rej(new Error('no geolocation'))
    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10_000, maximumAge: 3_600_000 })
  })
}

/** 手动城市优先；否则浏览器定位；都失败用上次缓存 */
export async function resolvePlace(city: string): Promise<Place | null> {
  const cached = readJSON<Place & { city?: string }>(LS_PLACE)
  let place: Place | null = null
  try {
    if (city) {
      place = cached?.city === city ? cached : await geocodeCity(city)
      if (place) place = { ...place, name: city }
    } else {
      const pos = await geolocate()
      const { latitude: lat, longitude: lon } = pos.coords
      const name = (cached && Math.hypot(cached.lat - lat, cached.lon - lon) < 0.1 && cached.name) || (await reverseName(lat, lon))
      place = { lat, lon, name }
    }
  } catch { /* 走缓存 */ }
  place ??= cached
  if (place) localStorage.setItem(LS_PLACE, JSON.stringify({ ...place, city }))
  return place
}

export async function fetchWeather(p: Place): Promise<Weather | null> {
  try {
    const j = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
        '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1',
    )
    const w: Weather = {
      temp: j.current.temperature_2m, code: j.current.weather_code,
      max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0], at: Date.now(),
    }
    localStorage.setItem(LS_WEATHER, JSON.stringify(w))
    return w
  } catch {
    const c = readJSON<Weather>(LS_WEATHER)
    return c && Date.now() - c.at < 6 * 3_600_000 ? c : null
  }
}

/** 是否夜间：有位置用日出日落，否则 6:00–18:00 */
export function isNight(d: Date, p: Place | null): boolean {
  if (p) {
    const t = SunCalc.getTimes(d, p.lat, p.lon)
    if (!isNaN(t.sunrise.getTime()) && !isNaN(t.sunset.getTime())) return d < t.sunrise || d > t.sunset
  }
  const h = d.getHours()
  return h < 6 || h >= 18
}

/** 光源方向（屏幕坐标，y 向上，指向光源）：早上左上，傍晚右上 */
export function lightDir(d: Date, p: Place | null): [number, number] {
  let az: number
  if (p) az = SunCalc.getPosition(d, p.lat, p.lon).azimuth // 南为 0，西为正
  else az = ((d.getHours() + d.getMinutes() / 60 - 12) / 6) * (Math.PI / 2)
  const x = Math.max(-1, Math.min(1, Math.sin(az))) * 0.75
  return [x, 0.66]
}
