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
uniform float u_tex;     // 面板纹理强度 0..1

const float R = 0.455;     // 凹盘半径（以 pitch 为单位）
const float LEN = 0.40;    // 指针长度
const float HW = 0.034;    // 指针半宽
const float DEPTH = 0.16;  // 凹盘深度
const float CAP = 1.3;     // 轴心帽半径 / 指针半宽

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
  // 轴心压一颗略粗的帽
  return min(min(d1, d2) - w, length(p) - w * CAP);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// 值噪声 + fbm：做面板的矿物灰泥质感
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = m * p; a *= 0.5; }
  return v;
}
// 材质高度场：大块云状起伏 + 细密颗粒 + 一层斜向纤维
float surf(vec2 g) {
  float cloud = fbm(g * 2.2);
  float grain = vnoise(g * 95.0);
  vec2 q = mat2(0.94, 0.34, -0.34, 0.94) * g;
  float fiber = vnoise(vec2(q.x * 6.0, q.y * 140.0));
  return cloud * 0.55 + grain * 0.25 + fiber * 0.2;
}
// 返回材质明暗系数：法线随高度场扰动，与光源方向点积产生极浅浮雕
float texShade(vec2 g, vec2 L2, float px) {
  float e = max(px, 0.002);
  float h0 = surf(g);
  vec2 grad = vec2(surf(g + vec2(e, 0.0)) - h0, surf(g + vec2(0.0, e)) - h0) / e;
  float relief = dot(grad, L2) * 0.0009;
  float mottle = (fbm(g * 0.9 + 7.3) - 0.5) * 0.028;
  return 1.0 + clamp(relief, -0.025, 0.025) + mottle + (h0 - 0.5) * 0.012;
}

// 指针材质：拉丝金属。截面是平顶+倒角，倒角朝光一侧出一道锐利高光；
// 顶面沿长度方向拉丝，各向异性光泽随指针转动扫过；轴心帽是旋压的同心纹
vec3 handShade(vec2 p, int i, vec3 L, float px) {
  float k = u_len[i];
  float w = max(HW * smoothstep(0.0, 0.2, k), 1e-5);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));

  // 找最近的那根
  vec2 b1 = dir(u_ang[i * 2]) * LEN * k, b2 = dir(u_ang[i * 2 + 1]) * LEN * k;
  float h1 = clamp(dot(p, b1) / dot(b1, b1), 0.0, 1.0);
  float h2 = clamp(dot(p, b2) / dot(b2, b2), 0.0, 1.0);
  vec2 q1 = p - b1 * h1, q2 = p - b2 * h2;
  bool first = dot(q1, q1) < dot(q2, q2);
  vec2 T = normalize(first ? b1 : b2);
  vec2 q = first ? q1 : q2;

  // 指针截面法线：中间平，外侧 45% 起倒角
  float lq = length(q);
  float u = clamp(lq / w, 0.0, 1.0);
  vec2 qh = lq > 1e-6 ? q / lq : vec2(0.0);
  vec3 nArm = normalize(vec3(qh * smoothstep(0.45, 1.0, u) * 2.6, 1.0));

  // 轴心帽：低圆顶 + 外缘倒角
  float capR = w * CAP;
  float dc = length(p);
  float uc = clamp(dc / capR, 0.0, 1.0);
  vec2 ch = dc > 1e-6 ? p / dc : vec2(0.0);
  vec3 nCap = normalize(vec3(ch * (uc * 0.5 + smoothstep(0.7, 1.0, uc) * 2.2), 1.0));
  float onCap = 1.0 - smoothstep(capR - px, capR + px, dc);
  vec3 n = normalize(mix(nArm, nCap, onCap));

  float diff = clamp(dot(n, L) / L.z, 0.0, 1.4);
  float spec = pow(max(dot(n, H), 0.0), 48.0);

  // 各向异性光泽：拉丝方向与光垂直时最亮
  vec2 Tg = mix(T, vec2(-ch.y, ch.x), onCap);
  float th = dot(Tg, H.xy);
  float aniso = pow(max(1.0 - th * th, 0.0), 40.0);
  aniso *= mix(1.0 - smoothstep(0.4, 0.85, u), 1.0 - smoothstep(0.6, 0.9, uc), onCap);

  // 拉丝纹以设备像素为尺度，避免缩放时走样
  float across = dot(p, vec2(-T.y, T.x)), along = dot(p, T);
  float gArm = vnoise(vec2(across / (px * 1.3), along / (px * 70.0))) - 0.5;
  float gCap = vnoise(vec2(dc / (px * 0.9), 0.5)) - 0.5;
  float grain = mix(gArm, gCap, onCap);

  // 深色指针靠高光出质感；夜间浅色指针本身亮，高光收一些
  float lum = dot(u_hand, vec3(0.299, 0.587, 0.114));
  float specK = mix(0.25, 1.0, 1.0 - lum) * mix(0.6, 1.0, u_shadow);
  vec3 c = u_hand * mix(1.0, diff, 0.6) * (1.0 + grain * 0.18);
  c += vec3(0.84, 0.87, 0.92) * specK * (spec * 0.3 + aniso * (0.07 + grain * 0.05));
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 g = (frag - u_origin) / u_pitch;
  float px = 1.0 / u_pitch;
  vec3 L = normalize(u_light);
  vec2 L2 = normalize(L.xy);

  // 面板：沿光源方向极轻的明暗渐变
  vec3 col = u_bg * (0.985 + 0.03 * dot(normalize(frag - u_origin - vec2(4.0, 1.5) * u_pitch + 1e-4), L2) * 0.5);
  float tex = mix(1.0, texShade(g, L2, px), u_tex);
  col *= tex;

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

    // 盘内同一材质，但被压光过，纹理更浅
    vec3 dish = u_bg * shade * mix(1.0, tex, 0.45);

    // 指针投影：离盘底有一段高度，沿光反方向偏移并虚化
    float lift = 0.035 + depthHere * 0.6;
    float sd = hands(p + L2 * lift, idx);
    // 收起/伸出时整根指针连同投影一起淡出/淡入
    float fade = smoothstep(0.0, 0.6, u_len[idx]);
    float sh = (1.0 - smoothstep(-0.02, 0.05, sd)) * fade;
    dish *= 1.0 - 0.16 * sh * u_shadow;

    col = mix(col, dish, inside);

    // 指针本体
    float hd = hands(p, idx);
    float cov = (1.0 - smoothstep(-px * 0.75, px * 0.75, hd)) * fade;
    if (cov > 0.0) col = mix(col, handShade(p, idx, L, px), cov * inside);
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
    bg: u('u_bg'), hand: u('u_hand'), shadow: u('u_shadow'), tex: u('u_tex'),
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
      // 夜里底色暗，同样的相对起伏更显眼，收一点
      gl.uniform1f(U.tex, 1.0 - 0.35 * (1.0 - f.palette.shadow) / 0.45)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}
