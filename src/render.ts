// 渲染器接口 + Canvas 2D 降级实现

import type { Palette } from './theme'
import { css } from './theme'

export interface Layout { x: number; y: number; pitch: number; w: number; h: number }

export interface Frame {
  angles: Float32Array
  layout: Layout
  dpr: number
  light: [number, number]
  palette: Palette
}

export interface Renderer { kind: 'webgl' | '2d'; draw(f: Frame): void }

export function create2D(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false })!
  return {
    kind: '2d',
    draw({ angles, layout, dpr, light, palette }: Frame) {
      const { pitch } = layout
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = css(palette.bg)
      ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr)
      const r = pitch * 0.455
      const len = pitch * 0.4
      const lx = light[0], ly = -light[1] // 屏幕 y 向下
      for (let i = 0; i < 24; i++) {
        const cx = layout.x + (i % 8 + 0.5) * pitch
        const cy = layout.y + (Math.floor(i / 8) + 0.5) * pitch
        // 凹盘：朝光一侧内壁暗、背光一侧亮
        const g = ctx.createRadialGradient(cx - lx * r * 0.25, cy - ly * r * 0.25, r * 0.55, cx, cy, r)
        g.addColorStop(0, css(palette.bg))
        g.addColorStop(1, css(palette.bg.map((v) => v * (1 - 0.12 * palette.shadow)) as Palette['bg']))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()

        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.clip()
        ctx.lineCap = 'round'
        ctx.lineWidth = pitch * 0.068
        const stroke = (ox: number, oy: number) => {
          ctx.beginPath()
          for (const a of [angles[i * 2], angles[i * 2 + 1]]) {
            const rad = (a * Math.PI) / 180
            ctx.moveTo(cx + ox, cy + oy)
            ctx.lineTo(cx + ox + Math.sin(rad) * len, cy + oy - Math.cos(rad) * len)
          }
          ctx.stroke()
        }
        ctx.strokeStyle = `rgba(0,0,0,${0.12 * palette.shadow})`
        stroke(-lx * pitch * 0.05, -ly * pitch * 0.05)
        ctx.strokeStyle = css(palette.hand)
        stroke(0, 0)
        ctx.restore()
      }
    },
  }
}
