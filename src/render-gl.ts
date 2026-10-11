// WebGL2 渲染：一个全屏三角形，凹盘、指针、软阴影都在片元着色器里用 SDF 算出来

import type { Frame, Renderer } from './render'

const VS = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 u_origin;   // 网格左下角（设备像素，y 向上）
uniform float u_pitch;   // 每个钟所占边长（设备像素）
uniform float u_ang[48]; // 角度（度），0 向上，顺时针
uniform float u_len[24]; // 指针长度系数 0..1（空格指针缩回到 0）
uniform vec3 u_light;    // 指向光源，z 为高度
uniform vec3 u_bg;
uniform vec3 u_hand;
uniform float u_shadow;

const float R = 0.455;     // 凹盘半径（以 pitch 为单位）
const float LEN = 0.40;    // 指针长度
const float HW = 0.034;    // 指针半宽
const float DEPTH = 0.16;  // 凹盘深度

float seg(vec2 p, vec2 b) {
  float h = clamp(dot(p, b) / dot(b, b), 0.0, 1.0);
  return length(p - b * h);
}
vec2 dir(float deg) { float a = radians(deg); return vec2(sin(a), cos(a)); }

float hands(vec2 p, int i) {
  float k = u_len[i];
  if (k <= 0.0) return 1.0;
  // 长度随 k 缩短；最后 20% 连粗细一起收掉，轴心不留圆点
  float w = HW * smoothstep(0.0, 0.2, k);
  float d1 = seg(p, dir(u_ang[i * 2]) * LEN * k);
  float d2 = seg(p, dir(u_ang[i * 2 + 1]) * LEN * k);
  return min(d1, d2) - w;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 g = (frag - u_origin) / u_pitch;
  float px = 1.0 / u_pitch;
  vec3 L = normalize(u_light);
  vec2 L2 = normalize(L.xy);

  // 面板：沿光源方向极轻的明暗渐变
  vec3 col = u_bg * (0.985 + 0.03 * dot(normalize(frag - u_origin - vec2(4.0, 1.5) * u_pitch + 1e-4), L2) * 0.5);

  ivec2 cell = ivec2(floor(g));
  if (cell.x >= 0 && cell.x < 8 && cell.y >= 0 && cell.y < 3) {
    int idx = (2 - cell.y) * 8 + cell.x;
    vec2 p = fract(g) - 0.5;
    float r = length(p) / R;
    float inside = 1.0 - smoothstep(1.0 - px / R, 1.0 + px / R, r);

    // 碗形剖面 h = DEPTH * (r^4 - 1)，越靠近边缘越陡
    vec2 ph = r > 1e-4 ? p / length(p) : vec2(0.0);
    float slope = 4.0 * DEPTH * pow(min(r, 1.0), 3.0) / R;
    vec3 n = normalize(vec3(-ph * slope, 1.0));
    float shade = clamp(mix(1.0, dot(n, L) / L.z, 0.45), 0.8, 1.06);

    // 边缘挡光：沿光源方向往回追，越出盘外就在阴影里
    float depthHere = DEPTH * (1.0 - pow(min(r, 1.0), 4.0));
    vec2 probe = p + L2 * depthHere * (length(L.xy) / L.z) * 1.6;
    float rimShadow = smoothstep(R * 0.86, R * 1.12, length(probe));
    shade *= mix(1.0, 0.93, rimShadow * u_shadow);

    // 底部环境光遮蔽 + 边缘高光
    float ao = smoothstep(0.7, 1.0, r);
    shade *= 1.0 - 0.035 * ao * u_shadow;
    float rim = smoothstep(0.93, 1.0, r) * (1.0 - smoothstep(1.0, 1.0 + 2.0 * px / R, r));
    shade += rim * 0.05 * max(0.0, -dot(ph, L2));

    vec3 dish = u_bg * shade;

    // 指针投影：离盘底有一段高度，沿光反方向偏移并虚化
    float lift = 0.035 + depthHere * 0.6;
    float sd = hands(p + L2 * lift, idx);
    float sh = 1.0 - smoothstep(-0.02, 0.05, sd);
    dish *= 1.0 - 0.16 * sh * u_shadow;

    col = mix(col, dish, inside);

    // 指针本体
    float hd = hands(p, idx);
    float cov = 1.0 - smoothstep(-px * 0.75, px * 0.75, hd);
    // 极轻的立体感：靠光一侧稍亮
    vec3 hc = u_hand * (1.0 + 0.04 * u_shadow);
    col = mix(col, hc, cov * inside);
  }

  col += (hash(frag) - 0.5) * 0.008;
  o = vec4(col, 1.0);
}`

export function createGL(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' })
  if (!gl) return null

  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  const prog = gl.createProgram()!
  try {
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  } catch (e) {
    console.warn('WebGL 着色器失败，退回 Canvas 2D', e)
    return null
  }
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const u = (n: string) => gl.getUniformLocation(prog, n)
  const U = {
    origin: u('u_origin'), pitch: u('u_pitch'), ang: u('u_ang'), len: u('u_len'), light: u('u_light'),
    bg: u('u_bg'), hand: u('u_hand'), shadow: u('u_shadow'),
  }

  return {
    kind: 'webgl',
    draw(f: Frame) {
      const { width: w, height: h } = canvas
      gl.viewport(0, 0, w, h)
      const s = f.dpr
      // 布局是 CSS 像素、y 向下；着色器要设备像素、y 向上
      gl.uniform2f(U.origin, f.layout.x * s, h - (f.layout.y + f.layout.pitch * 3) * s)
      gl.uniform1f(U.pitch, f.layout.pitch * s)
      gl.uniform1fv(U.ang, f.angles)
      gl.uniform1fv(U.len, f.lens)
      gl.uniform3f(U.light, f.light[0], f.light[1], 0.62)
      gl.uniform3fv(U.bg, f.palette.bg)
      gl.uniform3fv(U.hand, f.palette.hand)
      gl.uniform1f(U.shadow, f.palette.shadow)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}
