/*!
 * Fire Cursor — a living fire ring that follows the pointer, simulated in WebGL2.
 * Flames, trails, embers, edge flames on hovered elements, and optional liquid-glass reflections.
 * https://github.com/harshil-acharya/fire-cursor
 * (c) 2026 Harshil Acharya · MIT License
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    radius: 13,                 // radius of the fire ring around the pointer, in CSS px
    embers: 160,                // maximum number of glowing embers on screen
    edgeSelector: 'a, button, [role="button"], input, textarea, select, [data-fire-edge], .fc-glass',  // hovered elements whose outline catches small flames
    growSelector: 'a, button, [role="button"], [data-fire-grow]',   // the ring grows a little over these
    glassSelector: '.fc-glass', // elements that reflect the fire like liquid glass ('' to turn off)
    glassStrength: .25,         // 0 – 1: how strongly the glass picks up the firelight
    hideCursor: true,           // hide the system cursor while the fire is running
    theme: 'auto',              // 'auto' (reads the page background), 'light' or 'dark'
    zIndex: 2147483000,
    respectReducedMotion: true  // users who prefer reduced motion keep their normal cursor
  };

  function init(options) {
    const O = Object.assign({}, DEFAULTS, options || {});
    const noop = { destroy() {}, setTheme() {}, running: false };
    if (typeof window === 'undefined' || !window.matchMedia) return noop;
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return noop;            // touch devices: nothing to follow
    if (O.respectReducedMotion && matchMedia('(prefers-reduced-motion: reduce)').matches) return noop;

    const root = document.documentElement;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${O.zIndex}`;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return noop;                    // no WebGL2: leave the normal cursor alone

    const VS = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
  const NOISE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y); }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + 13.1; a *= .5; } return s; }`;
  // heat: advect (rise + vortex swirl + cursor wake), cool unevenly, add the fire-ring source
  const FS_HEAT = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev; uniform vec2 uView, uC, uV; uniform float dt, uT, uOn, uR, uSpin, uEdge, uCorner; uniform vec4 uRect;` + NOISE + `
vec2 curl(vec2 p){ float e = 1.5; float n1 = fbm(p + vec2(0, e) * .01), n2 = fbm(p - vec2(0, e) * .01), n3 = fbm(p + vec2(e, 0) * .01), n4 = fbm(p - vec2(e, 0) * .01);
  return vec2(n1 - n2, -(n3 - n4)) / (2. * e * .01); }
void main(){
  vec2 p = vec2(vUv.x, 1. - vUv.y) * uView;                 // CSS px, y down
  vec2 d = p - uC; float dist = length(d);
  // air motion: rising, swirling, and dragged along behind the moving cursor
  vec2 sw = curl(p * .04 + vec2(0., uT * .9)) * .55;
  float wake = exp(-dist * dist / (uR * uR * 6.));
  // a fire vortex: near the ring the flames are swept around it (wispy, wrapping arcs) more than they rise
  float zone = exp(-pow((dist - uR) / (uR * .95), 2.));
  vec2 tang = vec2(-d.y, d.x) / max(dist, 1.);
  vec2 vel = vec2(0., -(48. + 36. * noise(p * .07 + vec2(0., uT * 2.))) * (1. - .55 * zone)) + sw * 52. + tang * 95. * zone + uV * .3 * wake;
  vec2 back = p - vel * dt;
  float h = texture(uPrev, vec2(back.x / uView.x, 1. - back.y / uView.y)).r;
  // uneven cooling: some tongues survive longer and climb higher
  float cool = 5.2 + 4.8 * fbm(p * .06 + vec2(uT * .7, uT * 1.6)) + smoothstep(uR * 2., uR * 4.5, dist) * 6.;   // far from the pointer, fire dies quickly: short trails
  h *= exp(-cool * dt);
  // source: a ragged, breathing ring of fire around the pointer, patterned by procedural streaks
  float ang = atan(d.y, d.x);
  float rr = uR * (.86 + .22 * fbm(vec2(ang * 1.6 + uT * .8, uT * 1.3)));
  float ringW = uR * (.22 + .18 * noise(vec2(ang * 3., uT * 4.)));
  float ring = exp(-pow((dist - rr) / ringW, 2.)) * (1. - smoothstep(uR * .55, uR * .2, dist));   // dark, open centre
  // procedural flame pattern: wispy streaks that wrap around the ring and slowly turn with it
  float streak = fbm(vec2(ang * 2.4 + uSpin * 1.3, dist / uR * 1.7 - uT * .6));
  float wisp = noise(vec2(ang * 9. - uSpin * 2., dist * .35 + uT * 1.5));
  float pattern = smoothstep(.2, .7, streak) * (.7 + .3 * wisp);
  // flicker: around the ring (uneven), plus a fast, irregular global flutter like a real flame
  float flick = .5 + .75 * fbm(vec2(ang * 2.6 - uT * 1.3, uT * 9.));
  // two bright crescents on opposite sides, slowly circling, with thinner, dimmer flame between them
  float cres = .3 + .95 * pow(.5 + .5 * cos(2. * (ang - uSpin * 1.6) + .6 * noise(vec2(ang * 2., uT))), 1.6);
  flick *= cres;
  float flutter = .78 + .22 * noise(vec2(uT * 13., 1.7)) + .1 * sin(uT * 31. + sin(uT * 7.) * 2.);
  float src = clamp(ring * flick * flutter * (.6 + .9 * pattern), 0., 1.15) * uOn;
  // the hovered element's edge catches tiny flames where the cursor is near it
  vec2 hs = uRect.zw * .5; vec2 qq = abs(p - uRect.xy - hs) - hs + uCorner;
  float sd = length(max(qq, 0.)) + min(max(qq.x, qq.y), 0.) - uCorner;
  float near = exp(-dot(d, d) / (44. * 44.));
  float edge = exp(-sd * sd / 2.2) * near * (.35 + .65 * fbm(vec2(p.x * .09 + p.y * .09, uT * 8.))) * uEdge;
  src = max(src, edge * .5 * flutter);
  o = vec4(max(h, src) + src * .15, 0., 0., 1.);
}`;
  // display: heat → fire colour with a faint heat shimmer, plus the liquid-glass reflections
  const FS_SHOW = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 o;
uniform sampler2D uHeat; uniform vec2 uView; uniform float uT, uLight;
uniform vec4 uGs[8]; uniform float uGRs[8]; uniform int uGN; uniform float uGOn; uniform vec2 uCur; uniform float uCOn; uniform vec4 uEm[20]; uniform int uEmN; uniform float uGlassK;` + NOISE + `
vec3 ramp(float h){
  vec3 c = mix(vec3(.45, .04, .01), vec3(.95, .22, .02), smoothstep(.05, .32, h));
  c = mix(c, vec3(1., .55, .08), smoothstep(.28, .6, h));
  c = mix(c, vec3(1., .86, .4), smoothstep(.55, .9, h));
  return mix(c, vec3(1., .97, .86), smoothstep(.75, 1.1, h)) * 1.12;
}
vec2 toUv(vec2 q){ return vec2(q.x / uView.x, 1. - q.y / uView.y); }
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }

// LIQUID GLASS: each glass element is a slab with rounded, bevelled edges. The fire is its only light source,
// so everything below is driven by where the flames and embers are, every frame.
vec4 glassLight(vec2 p){
  // the glass surfaces near the fire arrive smallest-first, so a button inside a card wins over the card
  vec2 c0 = vec2(0.), b = vec2(0.); float uGR = 0., d = 1e4;
  for (int i = 0; i < 8; i++) { if (i >= uGN) break;
    vec2 cc = uGs[i].xy + uGs[i].zw * .5, bb = uGs[i].zw * .5; float rr = uGRs[i];
    float dd = sdRR(p - cc, bb, rr);
    if (dd < 1.5) { c0 = cc; b = bb; uGR = rr; d = dd; break; } }
  if (d > 1.5) return vec4(0.);
  float bev = min(16., min(b.x, b.y) * .8);
  float inside = 1. - smoothstep(-.5, 1., d);
  float e = clamp(-d / bev, 0., 1.);                     // 0 on the rim → 1 on the flat top
  vec2 gr = vec2(sdRR(p + vec2(1, 0) - c0, b, uGR) - sdRR(p - vec2(1, 0) - c0, b, uGR),
                 sdRR(p + vec2(0, 1) - c0, b, uGR) - sdRR(p - vec2(0, 1) - c0, b, uGR)) * .5;
  float slope = (1. - e) * (1. - e);
  // the surface is liquid: slow, shallow swells that the cursor's motion stirs
  vec2 sw = vec2(noise(p * .022 + vec2(uT * .35, 0.)), noise(p * .022 + vec2(4.1, uT * .3))) - .5;
  vec3 n = normalize(vec3(gr * slope * 2.2 + sw * .09, 1.));
  vec3 L = vec3(uCur - p, 64.); float dist = length(L); L /= dist;
  vec3 H = normalize(L + vec3(0., 0., 1.));
  float nh = max(dot(n, H), 0.);
  float fall = 1. / (1. + dist * dist / (125. * 125.));
  vec3 warm = vec3(1., .5, .14);

  // reflected flames: the glass mirrors the fire as a softer, slightly lower ghost image, rippled by the liquid surface
  vec2 q = p + vec2(0., -16.) + sw * 7.;
  float rh = 0.;
  rh += texture(uHeat, toUv(q)).r * .3;
  rh += texture(uHeat, toUv(q + vec2(3., 1.5))).r * .175;
  rh += texture(uHeat, toUv(q - vec2(3., 1.5))).r * .175;
  rh += texture(uHeat, toUv(q + vec2(-1.5, 3.5))).r * .175;
  rh += texture(uHeat, toUv(q + vec2(1.5, -3.5))).r * .175;
  vec3 refl = ramp(rh * 1.1) * smoothstep(.03, .3, rh) * .42;
  // a second, faint refracted copy seen through the glass body (dispersion: red and gold split slightly)
  vec2 q2 = p + vec2(0., 9.);
  float rr = texture(uHeat, toUv(q2 + vec2(1.5, 0.))).r, rg = texture(uHeat, toUv(q2 - vec2(1.5, 0.))).r;
  refl += vec3(rr * .9, rg * .45, rg * .08) * .35 * smoothstep(.02, .25, max(rr, rg));

  vec3 col = refl;
  // the rim catches the firelight: a fine glowing edge line, brightest on the side nearest the flames
  float line = exp(-pow((d + 1.2) / 1.3, 2.));   // a single fine edge line
  float side = .12 + .88 * max(dot(normalize(gr + 1e-4), normalize(uCur - p + 1e-4)), 0.);
  col += warm * line * side * side * fall * 1.6;
  // warm light spilling across the glass body (inner glow, gentle caustic shimmer)
  float caus = .6 + .8 * fbm(p * .05 + n.xy * 3. + vec2(uT * .5, -uT * .4));
  col += warm * fall * fall * mix(.15, .07, uLight) * caus * .5;

  // each glowing ember leaves its own soft reflection
  for (int i = 0; i < 20; i++) { if (i >= uEmN) break;
    vec4 em = uEm[i]; vec2 ep = em.xy + vec2(0., 16.) - n.xy * 30.;
    float g = exp(-dot(p - ep, p - ep) / 7.) * em.z * em.z;
    col += vec3(1., .62, .22) * g * .9;
  }
  col *= inside * uGOn * uGlassK;
  float a = clamp(max(col.r, max(col.g, col.b)), 0., 1.) * mix(.45, 1., uLight);
  return vec4(col, a);
}

void main(){
  vec2 p = vec2(vUv.x, 1. - vUv.y) * uView;
  vec4 G = uGOn > .001 ? glassLight(p) : vec4(0.);
  vec2 sh = vec2(noise(p * .09 + vec2(0., uT * 6.)), noise(p * .09 + vec2(7., uT * 5.))) - .5;   // heat shimmer
  float h = texture(uHeat, vUv + sh * 2.2 / uView).r;
  if (h < .02) { o = G; return; }
  // fine flame licks: detail the half-resolution heat with rising streaks, so edges are crisp and tongued
  float lick = fbm(vec2(p.x * .22, p.y * .1 + uT * 5.5)) * .7 + noise(vec2(p.x * .55, p.y * .24 + uT * 9.)) * .3;
  h *= .62 + .75 * lick;
  h *= .9 + .1 * noise(vec2(uT * 17., p.y * .02));                      // fine shimmer in brightness
  vec3 c = ramp(h);
  float a = smoothstep(.05, .26, h) * mix(.95, 1., uLight);    // bright, solid flames
  c = mix(c, c * vec3(.95, .82, .75), uLight * (1. - smoothstep(.5, .9, h)) * .25);
  o = vec4(c * a, a) + G * (1. - a);
}`;
  const VSE = `#version 300 es
precision highp float; in vec4 aE; uniform vec2 uView; uniform float uDpr; out float vL; out float vH;
void main(){ vL = aE.z; vH = fract(aE.w * 7.13); gl_Position = vec4(aE.x / uView.x * 2. - 1., 1. - aE.y / uView.y * 2., 0., 1.);
  gl_PointSize = (aE.w < .25 ? .8 : 1. + 1.1 * fract(aE.w * 3.7)) * uDpr * (.6 + .4 * aE.z); }`;
  const FSE = `#version 300 es
precision highp float; in float vL; in float vH; out vec4 o;
void main(){ float d = length(gl_PointCoord - .5); float a = (1. - smoothstep(.1, .5, d)) * vL * vL * .65;
  vec3 c = mix(vec3(1., .35, .06), vec3(1., .85, .45), vH * vL); o = vec4(c * a, a); }`;


    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const prog = (v, f, names) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}; for (const n of names) u[n] = gl.getUniformLocation(p, n); return { p, u }; };
    let PH, PS, PE;
    try {
      PH = prog(VS, FS_HEAT, ['uPrev', 'uView', 'uC', 'uV', 'dt', 'uT', 'uOn', 'uR', 'uSpin', 'uEdge', 'uCorner', 'uRect']);
      PS = prog(VS, FS_SHOW, ['uHeat', 'uView', 'uT', 'uLight', 'uGs', 'uGRs', 'uGN', 'uGOn', 'uCur', 'uCOn', 'uEm', 'uEmN', 'uGlassK']);
      PE = prog(VSE, FSE, ['uView', 'uDpr']);
    } catch (e) { console.warn('[fire-cursor] disabled:', e.message); return noop; }

    document.body.appendChild(canvas);
    let style = null;
    if (O.hideCursor) {
      style = document.createElement('style');
      style.textContent = 'html.fire-cursor-on,html.fire-cursor-on *,html.fire-cursor-on *::before,html.fire-cursor-on *::after{cursor:none!important}';
      document.head.appendChild(style); root.classList.add('fire-cursor-on');
    }

    const vao = gl.createVertexArray();
    const MAXE = Math.max(0, O.embers | 0), EB = new Float32Array(Math.max(1, MAXE) * 4), evao = gl.createVertexArray(), ebuf = gl.createBuffer();
    gl.bindVertexArray(evao); gl.bindBuffer(gl.ARRAY_BUFFER, ebuf); gl.bufferData(gl.ARRAY_BUFFER, EB.byteLength, gl.DYNAMIC_DRAW);
    const aLoc = gl.getAttribLocation(PE.p, 'aE'); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 4, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);

    // heat field: ping-pong half-float buffers at 1/1.5 of the CSS resolution
    let W = 0, H = 0, dpr = 1, hw = 0, hh = 0, heat = [];
    function target(w, h) { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return { t, f }; }
    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      const nw = Math.ceil(W / 1.5), nh = Math.ceil(H / 1.5);
      if (nw !== hw || nh !== hh) { for (const x of heat) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } hw = nw; hh = nh; heat = [target(hw, hh), target(hw, hh)]; }
      wake();
    }

    const R = O.radius;
    const C = { x: -999, y: -999, vx: 0, vy: 0, lx: 0, ly: 0, on: 0, onT: 0, big: 0, bigT: 0 };
    let host = null, hr = null, hrad = 0, edgeOn = 0, edgeAcc = 0, alive = true;
    const embers = []; let light = 1, raf = 0, last = 0, t = 0, spin = 0, emitAcc = 0, coolUntil = 0;
    const EMU = new Float32Array(80), GU = new Float32Array(32), GR = new Float32Array(8); let glassEls = [], glassAt = -1e9;

    // theme: is the page light or dark? (fire is drawn a little denser on light pages)
    function bgLum() {
      for (const el of [document.body, root]) {
        const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
        if (m && (m.length < 4 || +m[3] > .05)) return (.2126 * m[0] + .7152 * m[1] + .0722 * m[2]) / 255;
      }
      return matchMedia('(prefers-color-scheme: dark)').matches ? 0 : 1;
    }
    const readTheme = () => { light = O.theme === 'light' ? 1 : O.theme === 'dark' ? 0 : (bgLum() > .5 ? 1 : 0); };
    readTheme();
    const mo = new MutationObserver(readTheme);
    mo.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const mq = matchMedia('(prefers-color-scheme: dark)'), onScheme = () => setTimeout(readTheme, 0);
    mq.addEventListener && mq.addEventListener('change', onScheme);

    const onMove = e => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      if (C.x < -900) { C.lx = e.clientX; C.ly = e.clientY; }
      C.x = e.clientX; C.y = e.clientY; C.onT = 1;
      const tg = e.target && e.target.closest ? e.target : null;
      C.bigT = tg && O.growSelector && tg.closest(O.growSelector) ? 1 : 0;
      host = tg && O.edgeSelector ? tg.closest(O.edgeSelector) : null;
      wake();
    };
    const onLeave = () => { C.onT = 0; host = null; };
    const onLost = e => { e.preventDefault(); destroy(); };
    addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave, { passive: true });
    addEventListener('blur', onLeave);
    addEventListener('resize', resize, { passive: true });
    canvas.addEventListener('webglcontextlost', onLost);
    resize();

    function nearestEdge(r, x, y) {   // closest point on an element's outline to (x, y)
      const [l, tp, w, h] = r, cx = Math.max(l, Math.min(l + w, x)), cy = Math.max(tp, Math.min(tp + h, y));
      const dl = cx - l, dr = l + w - cx, dt2 = cy - tp, db = tp + h - cy, m = Math.min(dl, dr, dt2, db);
      return m === dl ? [l, cy] : m === dr ? [l + w, cy] : m === dt2 ? [cx, tp] : [cx, tp + h];
    }
    function wake() { if (alive && !raf) { last = 0; raf = requestAnimationFrame(frame); } }

    function frame(now) {
      raf = 0; if (!alive) return;
      const dt = Math.min((now - (last || now)) / 1000, 1 / 30) || 1 / 120; last = now;
      t += dt;
      const ivx = (C.x - C.lx) / dt, ivy = (C.y - C.ly) / dt; C.lx = C.x; C.ly = C.y;
      const kv = 1 - Math.exp(-dt * 14);
      C.vx += (Math.max(-2600, Math.min(2600, ivx)) - C.vx) * kv; C.vy += (Math.max(-2600, Math.min(2600, ivy)) - C.vy) * kv;
      C.on += (C.onT - C.on) * (1 - Math.exp(-dt * 9)); C.big += (C.bigT - C.big) * (1 - Math.exp(-dt * 8));
      spin += dt * (.35 + Math.hypot(C.vx, C.vy) / 2600);
      if (C.onT) coolUntil = now + 1600;
      // the hovered element: its outline catches small flames near the cursor
      if (host && host.isConnected) { const r = host.getBoundingClientRect(); hr = [r.left, r.top, r.width, r.height];
        hrad = Math.min(parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0, Math.min(r.width, r.height) / 2); }
      edgeOn += ((host ? 1 : 0) - edgeOn) * (1 - Math.exp(-dt * (host ? 6 : 2.5)));
      if (!host && edgeOn < .01) hr = null;

      // embers: a few drift off at rest, more (and quick tiny sparks) while moving
      const sp = Math.hypot(C.vx, C.vy);
      emitAcc += dt * (6 + Math.min(45, sp * .045)) * C.on;
      while (emitAcc >= 1 && embers.length < MAXE) { emitAcc -= 1; const a = Math.random() * 6.283, rr = R * (.7 + .4 * Math.random()), spark = Math.random() < .3;
        embers.push({ x: C.x + Math.cos(a) * rr, y: C.y + Math.sin(a) * rr - 5, vx: -C.vx * .1 + (Math.random() - .5) * (spark ? 110 : 40), vy: -C.vy * .1 - (spark ? 90 : 30) - Math.random() * 40,
          life: 1, rate: 1 / (spark ? .25 + Math.random() * .3 : .6 + Math.random() * .9), s: spark ? Math.random() * .25 : .25 + Math.random() * .75 }); }
      if (emitAcc > 1) emitAcc = 0;
      if (hr && edgeOn > .05) {          // embers rising from the hovered element's edge
        edgeAcc += dt * 14 * edgeOn;
        while (edgeAcc >= 1 && embers.length < MAXE) { edgeAcc -= 1;
          const [ex, ey] = nearestEdge(hr, C.x + (Math.random() - .5) * 90, C.y + (Math.random() - .5) * 60);
          if (Math.hypot(ex - C.x, ey - C.y) > 90) continue;
          embers.push({ x: ex, y: ey, vx: (Math.random() - .5) * 30, vy: -25 - Math.random() * 35, life: 1, rate: 1 / (.5 + Math.random() * .8), s: Math.random() }); }
        if (edgeAcc > 1) edgeAcc = 0;
      }
      for (let i = embers.length - 1; i >= 0; i--) { const e = embers[i]; e.life -= dt * e.rate;
        if (e.life <= 0) { embers.splice(i, 1); continue; }
        e.vy -= 70 * dt; e.vx *= Math.exp(-dt * 2); e.vy *= Math.exp(-dt * 1.1);
        e.x += (e.vx + Math.sin(t * 8 + e.s * 40) * 20) * dt; e.y += e.vy * dt; }

      // 1 · heat simulation
      gl.disable(gl.BLEND); gl.useProgram(PH.p); gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, heat[1].f); gl.viewport(0, 0, hw, hh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, heat[0].t); gl.uniform1i(PH.u.uPrev, 0);
      gl.uniform2f(PH.u.uView, W, H); gl.uniform2f(PH.u.uC, C.x, C.y); gl.uniform2f(PH.u.uV, C.vx, C.vy);
      gl.uniform1f(PH.u.dt, dt); gl.uniform1f(PH.u.uT, t); gl.uniform1f(PH.u.uOn, C.on);
      gl.uniform1f(PH.u.uR, R * (1 + .15 * C.big)); gl.uniform1f(PH.u.uSpin, spin);
      gl.uniform4f(PH.u.uRect, ...(hr || [-1e4, -1e4, 0, 0])); gl.uniform1f(PH.u.uCorner, hrad); gl.uniform1f(PH.u.uEdge, hr ? edgeOn * C.on : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3); heat.reverse();

      // 2 · draw the fire (and the glass reflections)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(PS.p); gl.bindVertexArray(vao); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, heat[0].t);
      gl.uniform1i(PS.u.uHeat, 0); gl.uniform2f(PS.u.uView, W, H); gl.uniform1f(PS.u.uT, t); gl.uniform1f(PS.u.uLight, light);
      let gN = 0;
      if (O.glassSelector && O.glassStrength > 0) {
        if (now - glassAt > 400) { glassAt = now; glassEls = Array.from(document.querySelectorAll(O.glassSelector)); }
        const near = [];
        for (const el of glassEls) { if (!el.isConnected) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          const dx = Math.max(r.left - C.x, 0, C.x - r.right), dy = Math.max(r.top - C.y, 0, C.y - r.bottom);
          if (dx * dx + dy * dy < 240 * 240) near.push([r, el]); }
        near.sort((a, b) => a[0].width * a[0].height - b[0].width * b[0].height);   // smallest first: a button inside a card wins
        gN = Math.min(8, near.length); GU.fill(0); GR.fill(0);
        for (let k = 0; k < gN; k++) { const [r, el] = near[k]; GU.set([r.left, r.top, r.width, r.height], k * 4);
          GR[k] = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.height / 2, r.width / 2); }
      }
      gl.uniform4fv(PS.u.uGs, GU); gl.uniform1fv(PS.u.uGRs, GR); gl.uniform1i(PS.u.uGN, gN);
      let n = 0; EMU.fill(0);
      if (gN) for (let i = embers.length - 1; i >= 0 && n < 20; i--) { const e = embers[i];
        if (Math.abs(e.x - C.x) < 300 && Math.abs(e.y - C.y) < 300) { EMU.set([e.x, e.y, e.life, e.s], n * 4); n++; } }
      gl.uniform4fv(PS.u.uEm, EMU); gl.uniform1i(PS.u.uEmN, n);
      gl.uniform1f(PS.u.uGOn, gN ? C.on : 0); gl.uniform2f(PS.u.uCur, C.x, C.y); gl.uniform1f(PS.u.uCOn, C.on);
      gl.uniform1f(PS.u.uGlassK, Math.max(0, Math.min(1, O.glassStrength)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (embers.length) {
        embers.forEach((e, i) => EB.set([e.x, e.y, e.life, e.s], i * 4));
        gl.useProgram(PE.p); gl.bindVertexArray(evao); gl.bindBuffer(gl.ARRAY_BUFFER, ebuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, EB, 0, embers.length * 4);
        gl.uniform2f(PE.u.uView, W, H); gl.uniform1f(PE.u.uDpr, dpr); gl.drawArrays(gl.POINTS, 0, embers.length);
      }
      gl.bindVertexArray(null);
      // burn while the pointer is on the page; after it leaves, let the fire cool, then sleep
      if (now < coolUntil || embers.length) raf = requestAnimationFrame(frame);
    }

    function destroy() {
      if (!alive) return; alive = false;
      if (raf) cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMove); document.removeEventListener('pointerleave', onLeave);
      removeEventListener('blur', onLeave); removeEventListener('resize', resize);
      mo.disconnect(); mq.removeEventListener && mq.removeEventListener('change', onScheme);
      root.classList.remove('fire-cursor-on'); if (style) style.remove();
      canvas.remove(); const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    }
    return {
      running: true,
      destroy,
      setTheme(th) { O.theme = th || 'auto'; readTheme(); },
      setGlassStrength(k) { O.glassStrength = +k || 0; wake(); }
    };
  }

  const api = { init, defaults: DEFAULTS, version: '1.0.0' };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.FireCursor = api;
})(typeof window !== 'undefined' ? window : this);
