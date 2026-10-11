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
uniform float u_blur[48];// 每根指针本帧快门内扫过的角度（度，带符号）
uniform vec2 u_res;      // 画布尺寸（设备像素）

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

// 长度随 k 缩短；最后 20% 连粗细一起收掉，轴心不留圆点
float handW(int i) { return HW * smoothstep(0.0, 0.2, u_len[i]); }
vec2 armB(int i, int j) { return dir(u_ang[i * 2 + j]) * LEN * u_len[i]; }

// 单根指针：j=0 在下层，j=1 叠在上层并带轴心帽；off 为角度偏移（运动模糊采样用）
float arm(vec2 p, int i, int j, float off) {
  if (u_len[i] <= 0.0) return 1.0;
  float w = handW(i);
  float d = seg(p, dir(u_ang[i * 2 + j] + off) * LEN * u_len[i]) - w;
  return j == 1 ? min(d, length(p) - w * CAP) : d;
}

// 运动模糊：在本帧扫过的角度区间 [-blur, 0] 上均匀取样求平均覆盖率（快门是盒形，拖影在身后）
const int MB = 12;
float armCov(vec2 p, int i, int j, float lo, float hi, float jit) {
  float blur = u_blur[i * 2 + j];
  if (abs(blur) < 0.4) return 1.0 - smoothstep(lo, hi, arm(p, i, j, 0.0));
  float s = 0.0;
  for (int k = 0; k < MB; k++) s += 1.0 - smoothstep(lo, hi, arm(p, i, j, -blur * (float(k) + jit) / float(MB)));
  return s / float(MB);
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
vec3 handShade(vec2 p, int i, int j, vec3 L, float px) {
  float w = max(handW(i), 1e-5);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));

  vec2 b = armB(i, j);
  vec2 T = normalize(b);
  vec2 q = p - b * clamp(dot(p, b) / dot(b, b), 0.0, 1.0);

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
  float onCap = (1.0 - smoothstep(capR - px, capR + px, dc)) * float(j);
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

  vec3 col = u_bg;
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
    float shade = clamp(mix(1.0, dot(n, L) / L.z, 0.45), 0.8, 1.04);

    // 盘口车削倒角：盘外一圈窄斜面朝盘心倾斜，背光一侧迎光变亮、朝光一侧变暗
    float cw = max(3.0 * px, 0.009);
    float dr = length(p) - R;
    float band = smoothstep(-px, 0.0, dr) * (1.0 - smoothstep(cw - px, cw, dr));
    // 靠盘口一侧最强，向外渐收；夜里底色暗，相对强度放大
    band *= mix(1.0, 0.35, clamp(dr / cw, 0.0, 1.0));
    col *= 1.0 + dot(-ph, L2) * 0.13 * mix(2.2, 1.0, u_shadow) * band;

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

    // 盘内与面板同一块料，略压暗；纹理保留大半，再叠一层喷砂哑光细颗粒（按像素尺度）
    float blast = (vnoise(g / (px * 1.4)) - 0.5) * 0.03;
    vec3 dish = u_bg * 0.965 * shade * mix(1.0, tex, 0.6) * (1.0 + blast * mix(0.5, 1.0, u_shadow));

    // 指针投影分两层：贴着边缘的紧实接触影 + 甩得更远、更虚的漫射影。
    // 上层指针离盘底更高，两层影子都偏得更远
    float lift = 0.035 + depthHere * 0.6;
    // 采样位置只做很轻的抖动，打散分层台阶又不显颗粒
    float jit = 0.5 + (hash(frag + 0.37) - 0.5) * 0.3;
    float farSh = 0.0, nearSh = 0.0;
    for (int j = 0; j < 2; j++) {
      float hgt = 1.0 + 0.3 * float(j);
      farSh = max(farSh, armCov(p + L2 * lift * hgt, idx, j, -0.03, 0.075, jit));
      nearSh = max(nearSh, armCov(p + L2 * 0.007 * hgt, idx, j, -px, 0.012, jit));
    }
    // 收起/伸出时整根指针连同投影一起淡出/淡入
    float fade = smoothstep(0.0, 0.6, u_len[idx]);
    dish *= (1.0 - 0.11 * farSh * fade * u_shadow) * (1.0 - 0.22 * nearSh * fade * u_shadow);

    col = mix(col, dish, inside);

    // 指针本体：先画下层，上层的影子落在下层上，再盖上层
    float aa = px * 0.75;
    float c0 = armCov(p, idx, 0, -aa, aa, jit) * fade;
    float c1 = armCov(p, idx, 1, -aa, aa, jit) * fade;
    if (c0 > 0.0) {
      float cs = 1.0 - smoothstep(-0.004, 0.014, arm(p + L2 * 0.012, idx, 1, 0.0));
      vec3 hc = handShade(p, idx, 0, L, px) * (1.0 - 0.5 * cs * mix(0.6, 1.0, u_shadow));
      col = mix(col, hc, c0 * inside);
    }
    if (c1 > 0.0) col = mix(col, handShade(p, idx, 1, L, px), c1 * inside);
  }

  // 整块面板被一盏灯照着：朝光一侧整体略亮并有一团柔光，四角压暗。
  // 作用在最终颜色上，盘、指针、阴影一起受光
  vec2 uv = (frag - 0.5 * u_res) / u_res.y;           // 以短边归一化，中心为 0
  float grad = dot(uv, L2) * 0.05;
  float glow = exp(-dot(uv - L2 * 0.55, uv - L2 * 0.55) * 1.6) * 0.035;
  float vig = 1.0 - 0.13 * smoothstep(0.35, 1.25, length(uv * vec2(0.8, 1.0)));
  col *= (1.0 + (grad + glow) * mix(0.6, 1.0, u_shadow)) * vig;

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
    bg: u('u_bg'), hand: u('u_hand'), shadow: u('u_shadow'), tex: u('u_tex'), blur: u('u_blur'), res: u('u_res'),
  }

  // 运动模糊：按上一帧到这一帧的角速度，换算成固定快门（≈1/120s，即 60fps 下 180° 快门）内扫过的角度
  const SHUTTER = 1000 / 120
  const prev = new Float32Array(48)
  const blur = new Float32Array(48)
  let prevT = -1

  return {
    kind: 'webgl',
    draw(f: Frame) {
      const now = performance.now()
      const dt = now - prevT
      let blurring = false
      for (let i = 0; i < 48; i++) {
        let d = f.angles[i] - prev[i]
        d -= 360 * Math.round(d / 360)
        // 太久没画（空闲后第一帧）或一帧跳得太远（瞬移），都不当作运动
        // dt 太小（同一毫秒内连画两帧）时速度不可靠，也不算
        let b = prevT < 0 || dt < 4 || dt > 100 || Math.abs(d) > 60 ? 0 : (d / dt) * SHUTTER
        b = Number.isFinite(b) ? Math.max(-25, Math.min(25, b)) : 0
        blur[i] = Math.abs(b) < 0.4 ? 0 : b
        if (blur[i] !== 0) blurring = true
        prev[i] = f.angles[i]
      }
      prevT = now

      const { width: w, height: h } = canvas
      gl.viewport(0, 0, w, h)
      const s = f.dpr
      // 布局是 CSS 像素、y 向下；着色器要设备像素、y 向上
      gl.uniform2f(U.origin, f.layout.x * s, h - (f.layout.y + f.layout.pitch * 3) * s)
      gl.uniform1f(U.pitch, f.layout.pitch * s)
      gl.uniform1fv(U.ang, f.angles)
      gl.uniform1fv(U.len, f.lens)
      gl.uniform1fv(U.blur, blur)
      gl.uniform2f(U.res, w, h)
      gl.uniform3f(U.light, f.light[0], f.light[1], 0.62)
      gl.uniform3fv(U.bg, f.palette.bg)
      gl.uniform3fv(U.hand, f.palette.hand)
      gl.uniform1f(U.shadow, f.palette.shadow)
      // 夜里底色暗，同样的相对起伏更显眼，收一点
      gl.uniform1f(U.tex, 1.0 - 0.35 * (1.0 - f.palette.shadow) / 0.45)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      // 还有拖影就再要一帧：静止下来的最后一帧必须是清晰的
      return blurring
    },
  }
}
