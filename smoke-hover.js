/*!
 * Smoke Hover — UI elements dissolve into flowing smoke where the cursor passes, then heal.
 * A companion to Fire Cursor: https://github.com/orbit-designs/fire-cursor
 * (c) 2026 Harshil Acharya · MIT License
 *
 * How it works
 *  · A ribbon of smoke strands (generated in code — no images) is laid along the cursor's actual path,
 *    only while it moves over a UI element. The empty background never gets smoke.
 *  · A GPU fluid solver ("stable fluids": advection, vorticity confinement, buoyancy, pressure
 *    projection) animates it: the cursor's wake drags the smoke and sheds alternating swirls.
 *  · The element under the smoke gives way along the smoke's own contours; its outline (or, for titles,
 *    its letters) is lifted, bent by the same flow, and carried off — then everything heals.
 *  · When the cursor stops or leaves, the smoke clears in a fraction of a second and the loop sleeps.
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    selector: 'button, a, input, textarea, select, [role="button"], h1, h2, h3, [data-smoke], [data-smoke-text]',  // elements that smoke on hover
    textSelector: 'h1, h2, h3, [data-smoke-text]',   // titles: the letters themselves bend and dissolve
    float: true,                 // hovered elements lean a few px toward the cursor (magnetic float)
    floatSelector: 'button, a, input, textarea, select, [role="button"], h1, h2, h3, p, li, img, [data-smoke], [data-float]',
    density: 1,                  // how much smoke is released (0.3 – 1.5)
    linger: 1,                   // how long smoke lasts before clearing (0.5 – 2)
    theme: 'auto',               // 'auto' (reads the page background), 'light' or 'dark'
    lightSmoke: [.07, .07, .08], // smoke colour on light pages (RGB 0–1)
    darkSmoke: [.93, .93, .95],  // smoke colour on dark pages
    zIndex: 2147482000,          // just under Fire Cursor
    touch: true,                 // on phones and tablets, dragging a finger over an element smokes it
    respectReducedMotion: true
  };

  function init(options) {
    const O = Object.assign({}, DEFAULTS, options || {});
    const noop = { destroy() {}, setTheme() {}, running: false };
    if (typeof window === 'undefined' || !window.matchMedia) return noop;
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!fine && !O.touch) return noop;
    if (O.respectReducedMotion && matchMedia('(prefers-reduced-motion: reduce)').matches) return noop;
    const root = document.documentElement;
    const SEL = O.selector, TEXTY = O.textSelector || '\u0000';
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    let alive = true, E = null;

  /* ------------------------------------------------------------------ shaders */
  const VS = `#version 300 es
precision highp float;
uniform vec2 texelSize;
out vec2 vUv, vL, vR, vT, vB;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.);
  vL = vUv - vec2(texelSize.x, 0.); vR = vUv + vec2(texelSize.x, 0.);
  vT = vUv + vec2(0., texelSize.y); vB = vUv - vec2(0., texelSize.y);
}`;
  const H = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 o;
`;
  // the stroke this frame: segment A→B in CSS px, with arc length (for the smoke ribbon) and the touched element
  const STROKE = `
uniform vec2 uView, uA, uB; uniform float uArc, uOn, uTime, uWidth; uniform vec4 uRect; uniform float uCorner;
float sdRB(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
uniform float uEdgeW, uEdgeA, uIsText; uniform sampler2D uGlyph;
float glyph(vec2 p){ vec2 q = (p - uRect.xy) / uRect.zw; if (q.x < 0. || q.y < 0. || q.x > 1. || q.y > 1.) return 0.; return texture(uGlyph, q).a; }
float glyphFat(vec2 p){ return max(max(glyph(p + vec2(1.5, 0.)), glyph(p - vec2(1.5, 0.))), max(glyph(p + vec2(0., 1.5)), glyph(p - vec2(0., 1.5)))); }
float edgeSD(vec2 p){ vec2 hs = uRect.zw * .5; return sdRB(p - uRect.xy - hs, hs, uCorner); }
float insideEl(vec2 p, float feather){ vec2 hs = uRect.zw * .5; return 1. - smoothstep(-feather, feather, sdRB(p - uRect.xy - hs, hs, uCorner)); }
// position relative to the stroke: x = arc length along it (CSS px), y = signed distance across it,
// z = how far past either end of this frame's segment (0 inside), w = 1 on the segment, fading softly past its ends
vec4 strokeFrame(vec2 p){
  vec2 ba = uB - uA; float L = max(length(ba), 1e-3); vec2 t = ba / L, n = vec2(-t.y, t.x);
  float h = clamp(dot(p - uA, t) / L, 0., 1.);
  vec2 c = uA + ba * h;
  float past = dot(p - c, t);
  return vec4(uArc + h * L + past, dot(p - c, n), past, exp(-pow(past / (uWidth * .22), 2.)));
}`;
  const FS = {
    advect: H + `uniform sampler2D uVelocity, uSource; uniform vec2 texelSize; uniform float dt, dissipation;
void main(){ vec2 c = vUv - dt * texture(uVelocity, vUv).xy * texelSize; o = texture(uSource, c) / (1. + dissipation * dt); }`,
    curl: H + `uniform sampler2D uVelocity;
void main(){ float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y, T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
  o = vec4(.5 * (R - L - T + B), 0., 0., 1.); }`,
    vorticity: H + `uniform sampler2D uVelocity, uCurl, uDye; uniform float curl, dt, buoy;
void main(){
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x, T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
  vec2 f = .5 * vec2(abs(T) - abs(B), abs(R) - abs(L)); f /= length(f) + 1e-4; f *= curl * C; f.y *= -1.;
  vec2 v = texture(uVelocity, vUv).xy + f * dt;
  v.y += texture(uDye, vUv).r * buoy * dt;
  o = vec4(clamp(v, -900., 900.), 0., 1.); }`,
    divergence: H + `uniform sampler2D uVelocity;
void main(){
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x, T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.) L = -C.x; if (vR.x > 1.) R = -C.x; if (vT.y > 1.) T = -C.y; if (vB.y < 0.) B = -C.y;
  o = vec4(.5 * (R - L + T - B), 0., 0., 1.); }`,
    clear: H + `uniform sampler2D uTexture; uniform float value; void main(){ o = value * texture(uTexture, vUv); }`,
    pressure: H + `uniform sampler2D uPressure, uDivergence;
void main(){ float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x, T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4((L + R + B + T - texture(uDivergence, vUv).x) * .25, 0., 0., 1.); }`,
    gradient: H + `uniform sampler2D uPressure, uVelocity;
void main(){ float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x, T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4(texture(uVelocity, vUv).xy - vec2(R - L, T - B), 0., 1.); }`,
    // the cursor's wake: drag along the path, plus an alternating sideways push that sheds swirls (waves, curls)
    splatVel: H + STROKE + `uniform sampler2D uTarget; uniform vec2 uPV; uniform float uPx;
void main(){
  vec2 p = vec2(vUv.x, 1. - vUv.y) * uView, v = texture(uTarget, vUv).xy;
  vec4 s = strokeFrame(p);
  float g = exp(-pow(s.y / (uWidth * .55), 2.)) * s.w * uOn;
  vec2 dir = normalize(uB - uA + 1e-4), nrm = vec2(-dir.y, dir.x);
  float wave = sin(s.x * .045 + uTime * 2.2);
  vec2 css = uPV * .55 + nrm * wave * length(uPV) * .22;
  v = mix(v, vec2(css.x, -css.y) * uPx, clamp(g * .3, 0., 1.));
  o = vec4(v, 0., 1.); }`,
    // a ribbon of smoke strands laid along the path: the strand texture runs along the stroke
    splatDye: H + STROKE + `uniform sampler2D uTarget, uAtlas; uniform vec4 uCell; uniform float uFlowH, uFlip, uAmt, uLen;
void main(){
  vec2 p = vec2(vUv.x, 1. - vUv.y) * uView;
  vec4 s = strokeFrame(p);
  float across = s.y / uWidth * uFlip + .5;
  vec2 dg = texture(uTarget, vUv).rg; float d = dg.r;
  if (across > 0. && across < 1.) {
    // two copies of the strands, half a length apart, cross-faded: the ribbon never shows a seam where the texture repeats
    float a1 = fract(s.x / uLen), a2 = fract(s.x / uLen + .5), w1 = 1. - abs(a1 * 2. - 1.);
    vec2 i1 = uFlowH > .5 ? vec2(a1, across) : vec2(across, 1. - a1), i2 = uFlowH > .5 ? vec2(a2, across) : vec2(across, 1. - a2);
    vec2 u1 = uCell.xy + clamp(i1, .003, .997) * uCell.zw, u2 = uCell.xy + clamp(i2, .003, .997) * uCell.zw;
    float p1 = mix(textureLod(uAtlas, u1, .2).a, textureLod(uAtlas, u1, 2.2).a * 1.3, .15);   // sharp strands, a little body
    float p2 = mix(textureLod(uAtlas, u2, .2).a, textureLod(uAtlas, u2, 2.2).a * 1.3, .15);
    float photo = p1 * w1 + p2 * (1. - w1);
    float fade = smoothstep(0., .18, across) * smoothstep(1., .82, across) * s.w;   // no hard ribbon edge
    d += photo * fade * uAmt;
  }
  o = vec4(min(d, 1.6), dg.g, 0., 1.); }`,
    // the element's outline where the cursor passes is handed to the fluid: it warps, ripples and peels off with the smoke
    edgeInk: H + STROKE + `uniform sampler2D uTarget, uD;
void main(){
  vec2 p = vec2(vUv.x, 1. - vUv.y) * uView;
  vec2 dg = texture(uTarget, vUv).rg;
  float sd = edgeSD(p), line = 1. - smoothstep(uEdgeW * .5, uEdgeW * .5 + 1., abs(sd + uEdgeW * .5));
  line = mix(line, glyph(p), uIsText);              // titles: the letterforms themselves are handed to the fluid
  float take = texture(uD, vUv).g * uOn;
  float l = line * take;
  o = vec4(min(dg.r + l * .35, 1.6), max(dg.g, l * uEdgeA), 0., 1.); }`,
    // which part of the UI may dissolve: the band the cursor just swept, inside the touched element (never shown itself)
    path: H + STROKE + `uniform sampler2D uD; uniform float uHeal;
void main(){ vec2 p = vec2(vUv.x, 1. - vUv.y) * uView;
  vec4 s = strokeFrame(p);
  float band = exp(-pow(s.y / (uWidth * .75), 2.)) * s.w * uOn;
  float sd = edgeSD(p);
  float body = band * (1. - smoothstep(-1., 3., sd));
  float rim = band * mix(1. - smoothstep(uEdgeW + 1., uEdgeW + 3.5, abs(sd + uEdgeW * .5)), glyphFat(p), uIsText) * step(.001, uEdgeA);
  vec2 old = texture(uD, vUv).rg * uHeal;
  o = vec4(max(old.r, body), max(old.g, smoothstep(.15, .6, rim)), 0., 1.); }`,
    display: H + `uniform sampler2D uDye, uD, uGlyph; uniform vec2 uCanvas, uView; uniform vec3 uSmoke, uPage, uEdgeCol; uniform float uDark;
uniform vec4 uRect; uniform float uCorner, uEdgeW, uEdgeA, uTime, uIsText;
float glyph(vec2 p){ vec2 q = (p - uRect.xy) / uRect.zw; if (q.x < 0. || q.y < 0. || q.x > 1. || q.y > 1.) return 0.; return texture(uGlyph, q).a; }
float sdRB(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
void main(){
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec2 tx = 1. / vec2(textureSize(uDye, 0));
  float d = texture(uDye, uv).r;
  float dR = texture(uDye, uv + vec2(tx.x, 0.)).r, dL = texture(uDye, uv - vec2(tx.x, 0.)).r;
  float dT = texture(uDye, uv + vec2(0., tx.y)).r, dB = texture(uDye, uv - vec2(0., tx.y)).r;
  vec2 g = vec2(dR - dL, dT - dB);
  d = max(d + (d - (dR + dL + dT + dB) * .25) * 1.6, 0.);   // unsharp: keeps the strands crisp as the fluid carries them
  // smoke shading after the reference footage: soft translucent body, folds read denser, flat sheets catch light
  float rim = clamp(length(g) * 1.2, 0., 1.);
  float lit = clamp(dot(normalize(vec3(-g, .2)), normalize(vec3(-.45, .6, .65))), 0., 1.);
  // soft-capped density: thick smoke stays translucent (no black patches), thin strands stay crisp
  float a = (1. - exp(-d * .95)) * (.55 + .5 * rim);
  a = .56 * a / (.56 + a) * 2.;  a = min(a, .58);   // a touch darker, still translucent
  vec3 c = mix(uSmoke, mix(uSmoke + vec3(.34), uSmoke * .78, uDark), lit * .6 * (1. - rim));
  c = mix(c, uSmoke * .85, rim * .25);
  // the UI under the smoke gives way along the smoke's own contours: no brush, no circle
  vec2 D = texture(uD, uv).rg;
  float gone = D.r * smoothstep(.06, .45, d) * .94;
  // the real outline is lifted where the fluid has taken it, the lifted outline flows on as part of the smoke
  float lifted = D.g;
  float ink = texture(uDye, uv + g * .002).g;
  // inside the lifted zone the outline is redrawn bent by the smoke itself: same field, same frame, so they move as one
  vec2 p = vec2(uv.x, 1. - uv.y) * uView;
  vec2 warp = vec2(g.x, -g.y) * 92. + vec2(sin(p.y * .09 + uTime * 6.), cos(p.x * .09 - uTime * 5.)) * 2.2 * lifted;
  vec2 hs = uRect.zw * .5;
  float sdw = sdRB(p + warp * lifted - uRect.xy - hs, hs, uCorner);
  float border = (1. - smoothstep(uEdgeW * .5 - .3, uEdgeW * .5 + 1.2, abs(sdw + uEdgeW * .5))) * smoothstep(.05, .5, lifted) * (1. - smoothstep(.6, 1., lifted));
  // letters: stay whole but bend with the smoke, then thin away into it where the smoke is thick
  float letters = glyph(p + warp * lifted * .75) * smoothstep(.05, .4, lifted) * (1. - smoothstep(.2, .95, d) * .75);
  float wavy = mix(border, letters, uIsText) * uEdgeA;   // the edge / letters, bent by the same field that moves the smoke
  ink = clamp(max(ink * .75, wavy), 0., mix(.6, .85, uIsText));
  vec4 under = vec4(uPage * max(gone, lifted), max(gone, lifted));
  vec4 edge = vec4(uEdgeCol * ink, ink);
  vec4 smoke = vec4(c * a, a);
  o = smoke + (edge + under * (1. - edge.a)) * (1. - a);
}`,
  };

  /* ------------------------------------------------------------------ smoke strands, generated in code */
  // six cells of wispy strands (fine lines, medium threads and a soft body), each running left to right
  const atlasCells = [];
  function makeAtlas() {
    const CW = 768, CH = 256, cv = document.createElement('canvas'); cv.width = CW * 3; cv.height = CH * 2;
    const x = cv.getContext('2d'), canFilter = 'filter' in x;
    for (let k = 0; k < 6; k++) {
      let seed = 1234 + k * 977; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const ox = (k % 3) * CW, oy = Math.floor(k / 3) * CH;
      x.save(); x.beginPath(); x.rect(ox, oy, CW, CH); x.clip(); x.translate(ox, oy);
      const strand = (w, a, spread) => {
        const cy = CH / 2 + (rnd() + rnd() + rnd() - 1.5) * spread;
        const A1 = 6 + rnd() * 26, F1 = (1 + rnd() * 2.5) * Math.PI * 2 / CW, P1 = rnd() * 6.28;
        const A2 = 2 + rnd() * 9, F2 = (4 + rnd() * 8) * Math.PI * 2 / CW, P2 = rnd() * 6.28;
        const x0 = -40 + rnd() * CW * .3, x1 = CW * (.7 + rnd() * .3) + 40, drift = (rnd() - .5) * .08;
        x.beginPath();
        for (let px = x0; px <= x1; px += 6) {
          const py = cy + A1 * Math.sin(F1 * px + P1) + A2 * Math.sin(F2 * px + P2) + (px - x0) * drift;
          px === x0 ? x.moveTo(px, py) : x.lineTo(px, py);
        }
        x.lineWidth = w; x.strokeStyle = `rgba(255,255,255,${a})`; x.stroke();
      };
      x.lineCap = 'round'; x.lineJoin = 'round';
      if (canFilter) x.filter = 'blur(14px)';
      for (let i = 0; i < 3; i++) strand(26 + rnd() * 30, .1 + rnd() * .08, 26);       // soft body
      if (canFilter) x.filter = 'blur(2px)';
      for (let i = 0; i < 14; i++) strand(2 + rnd() * 4, .16 + rnd() * .22, 40);          // threads
      if (canFilter) x.filter = 'none';
      for (let i = 0; i < 34; i++) strand(.7 + rnd() * 1.2, .45 + rnd() * .5, 50);        // fine, crisp strands
      x.restore();
      atlasCells.push({ cell: [ox / cv.width, oy / cv.height, CW / cv.width, CH / cv.height], flowH: true, len: CW / CH });
    }
    return cv;
  }

  /* ------------------------------------------------------------------ engine */
  function makeEngine() {
    const canvas = document.createElement('canvas'); canvas.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:${O.zIndex}`; canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return null;
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const vs = sh(gl.VERTEX_SHADER, VS), P = {};
    for (const k in FS) {
      const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS[k])); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      P[k] = { p, u };
    }
    const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
    const eng = { gl, canvas, P, vao: gl.createVertexArray(), weak, iters: weak ? 14 : 20, atlasTex: null, fbo: {}, W: 0, H: 0 };
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    function target(w, h, ifmt, fmt) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { t, f, w, h, tx: [1 / w, 1 / h] };
    }
    const double = (...a) => { let x = target(...a), y = target(...a); return { w: x.w, h: x.h, tx: x.tx, get read() { return x; }, get write() { return y; }, swap() { [x, y] = [y, x]; } }; };
    eng.reset = () => {
      for (const k in eng.fbo) { const x = eng.fbo[k]; for (const y of (x.read ? [x.read, x.write] : [x])) { gl.bindFramebuffer(gl.FRAMEBUFFER, y.f); gl.viewport(0, 0, y.w, y.h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.clear(gl.COLOR_BUFFER_BIT);
    };
    eng.resize = () => {
      const W = innerWidth, Hh = innerHeight, dpr = Math.min(devicePixelRatio || 1, weak ? 1 : 1.5);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
      if (W === eng.W && Hh === eng.H) return;
      eng.W = W; eng.H = Hh;
      for (const k in eng.fbo) { const x = eng.fbo[k]; for (const y of (x.read ? [x.read, x.write] : [x])) { gl.deleteTexture(y.t); gl.deleteFramebuffer(y.f); } }
      const asp = W / Hh, fit = s => asp >= 1 ? [Math.round(s * asp), s] : [s, Math.round(s / asp)];
      const [sw, shh] = fit(weak ? 150 : 230), [dw, dh] = fit(weak ? 700 : 1300), [mw, mh] = fit(weak ? 400 : 700);
      eng.fbo = { vel: double(sw, shh, gl.RG16F, gl.RG), dye: double(dw, dh, gl.RG16F, gl.RG), path: double(mw, mh, gl.RG16F, gl.RG),
        div: target(sw, shh, gl.R16F, gl.RED), curl: target(sw, shh, gl.R16F, gl.RED), pres: double(sw, shh, gl.R16F, gl.RED) };
      eng.px = sw / W;
      eng.reset();
    };
    eng.resize();
    return eng;
  }
  function run(prog, dst, set) {
    const { gl } = E; gl.useProgram(prog.p);
    if (dst) { gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f); gl.viewport(0, 0, dst.w, dst.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, E.canvas.width, E.canvas.height); }
    let unit = 0;
    for (const k in set) {
      const v = set[k], loc = prog.u[k]; if (loc == null || v == null) continue;
      if (v && v.f !== undefined) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.t); gl.uniform1i(loc, unit++); }
      else if (v instanceof WebGLTexture) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v); gl.uniform1i(loc, unit++); }
      else if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.bindVertexArray(E.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ------------------------------------------------------------------ cursor, element, motion */
  const P = { x: -1e4, y: -1e4, px: -1e4, py: -1e4, vx: 0, vy: 0 };
  let host = null, hostInfo = null, raf = 0, last = 0, simT = 0, idleSince = 0, arc = 0, moveEnv = 0;
  let inten = 0, page = [1, 1, 1];
  let ribbon = { k: 0, flip: 1 }, edgeCol = [0, 0, 0], dispRect = { rect: [-1e4, -1e4, 0, 0], corner: 0, edgeW: 1, edgeA: 0 };
  function rectOf(el) {
    if (el.matches(TEXTY)) { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); if (b.width) return b; }
    return el.getBoundingClientRect();
  }
  function measure() {
    if (!host || !host.isConnected) { host = null; hostInfo = null; return; }
    if (!E.glyphTex) { const { gl } = E; E.glyphTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, E.glyphTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); }
    const r = rectOf(host), cs = getComputedStyle(host);
    // the element's own outline: a real border, an inset hairline, or (for solid dark buttons) its fill edge
    let ea = 0, ew = 1, col = [0, 0, 0];
    const rgba = s => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const v = m[1].split(',').map(parseFloat); return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] == null ? 1 : v[3]]; };
    const bw = parseFloat(cs.borderTopWidth) || 0, ins = /inset\s+0px\s+0px\s+0px\s+([\d.]+)px/.exec(cs.boxShadow) || /rgba?\([^)]+\)\s+0px\s+0px\s+0px\s+([\d.]+)px\s+inset/.exec(cs.boxShadow);
    const bg = rgba(cs.backgroundColor);
    if (bw > 0 && rgba(cs.borderTopColor)?.[3] > 0) { const c = rgba(cs.borderTopColor); ea = c[3]; ew = bw; col = c.slice(0, 3); }
    else if (ins) { const c = rgba(cs.boxShadow); ea = c ? c[3] : .15; ew = parseFloat(ins[1]); col = c ? c.slice(0, 3) : col; }
    else if (bg && bg[3] > .5 && bg[0] + bg[1] + bg[2] < 1) { ea = bg[3]; ew = 2.5; col = bg.slice(0, 3); }
    const isText = host.matches(TEXTY);
    if (isText) { ea = 1; const c = rgba(cs.color); col = c ? c.slice(0, 3) : col; if (glyphFor !== host) buildGlyphs(host, r); }
    hostInfo = { rect: [r.left, r.top, r.width, r.height], edgeA: isText ? .85 : clamp(ea * 2.6, 0, .65), edgeW: Math.max(1, ew), edgeCol: col, isText: isText ? 1 : 0,
      corner: host.matches(TEXTY) ? 4 : Math.min(parseFloat(cs.borderTopLeftRadius) || 0, Math.min(r.width, r.height) / 2),
      width: clamp(Math.min(r.width, r.height) * .55, 22, 50) };   // ribbon width: kept tight so the smoke stays at the cursor and the edge
  }
  // titles: draw the words into a mask (in the element's own box) so the smoke can take letters apart
  let glyphFor = null;
  function buildGlyphs(el, box) {
    glyphFor = el;
    const S = 1.5, cv = document.createElement('canvas'); cv.width = Math.max(1, Math.ceil(box.width * S)); cv.height = Math.max(1, Math.ceil(box.height * S));
    const x = cv.getContext('2d'); x.scale(S, S); x.fillStyle = '#000'; x.textBaseline = 'alphabetic';
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (let n; (n = walk.nextNode());) {
      const cs = getComputedStyle(n.parentElement);
      x.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if ('letterSpacing' in x) x.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      const t = n.nodeValue, re = /\S+/g; let m;
      while ((m = re.exec(t))) {
        range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        const rc = range.getClientRects()[0]; if (!rc) continue;
        const asc = x.measureText(m[0]).fontBoundingBoxAscent || rc.height * .8;
        x.fillText(m[0], rc.left - box.left, rc.top - box.top + asc);
      }
    }
    const { gl } = E; gl.bindTexture(gl.TEXTURE_2D, E.glyphTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  }
  function newRibbon() { let k; do k = Math.floor(Math.random() * 6); while (k === ribbon.k); ribbon = { k, flip: Math.random() < .5 ? -1 : 1 }; }

  function frame(now) {
    raf = 0;
    if (!E) return;
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now; simT += dt;
    // runs at the display's own refresh rate (120 Hz screens get 120 fps); if frames start running long, the solver lightens itself
    E.ft = (E.ft || dt) * .9 + dt * .1;
    if (E.ft > 1 / 50 && E.iters > 10) E.iters--; else if (E.ft < 1 / 100 && E.iters < (E.weak ? 14 : 20)) E.iters++;
    const { fbo } = E;
    measure();
    // how much the cursor moved since the last frame: the effect only runs on movement
    const A = [P.px, P.py], B = [P.x, P.y], seg = Math.hypot(B[0] - A[0], B[1] - A[1]);
    P.px = P.x; P.py = P.y;
    const k = 1 - Math.exp(-dt * 20);
    P.vx += ((B[0] - A[0]) / Math.max(dt, 1e-3) - P.vx) * k; P.vy += ((B[1] - A[1]) / Math.max(dt, 1e-3) - P.vy) * k;
    const moving = seg > .4, touching = moving && !!hostInfo;
    // intensity: 100% while moving over a UI element, nothing at all over the empty background
    inten += ((hostInfo ? 1 : 0) - inten) * (1 - Math.exp(-dt / (hostInfo ? .16 : .06)));
    const speed = Math.hypot(P.vx, P.vy);
    moveEnv += ((moving ? 1 : 0) - moveEnv) * (1 - Math.exp(-dt * (moving ? 18 : 7)));
    if (moving) { idleSince = now; arc += seg; } else if (now - idleSince > 260) newRibbon.pending = true;
    if (moving && newRibbon.pending) { newRibbon(); newRibbon.pending = false; }        // each new gesture gets a different strand pattern
    const hi = hostInfo || { rect: [-1e4, -1e4, 0, 0], corner: 0, width: 34, edgeW: 1, edgeA: 0 };
    const cell = atlasCells[ribbon.k];
    const tex = E.atlasTex;
    const stroke = { uView: [E.W, E.H], uA: A, uB: B, uArc: arc - seg, uOn: touching ? 1 : 0, uTime: simT, uWidth: hi.width, uRect: hi.rect, uCorner: hi.corner, uEdgeW: hi.edgeW || 1, uEdgeA: hi.edgeA || 0, uIsText: hi.isText || 0, uGlyph: E.glyphTex };
    if (hostInfo) { edgeCol = hostInfo.edgeCol; dispRect = hostInfo; }
    const vel = fbo.vel, dye = fbo.dye, path = fbo.path, txs = vel.tx;
    // smoke clears fast once the cursor stops (~0.35 s); while moving it lives just long enough to curl (~0.6 s), so it stays close to the cursor
    const fade = (hostInfo ? 4.8 - 2.9 * moveEnv : 9.) / O.linger;   // off an element, any smoke left clears quickly
    if (moving && hostInfo) { run(E.P.splatVel, vel.write, { ...stroke, uOn: inten, uTarget: vel.read, uPV: [P.vx, P.vy], uPx: E.px, texelSize: txs }); vel.swap(); }
    run(E.P.curl, fbo.curl, { uVelocity: vel.read, texelSize: txs });
    run(E.P.vorticity, vel.write, { uVelocity: vel.read, uCurl: fbo.curl, uDye: dye.read, curl: 14, dt, buoy: 13, texelSize: txs }); vel.swap();
    run(E.P.divergence, fbo.div, { uVelocity: vel.read, texelSize: txs });
    run(E.P.clear, fbo.pres.write, { uTexture: fbo.pres.read, value: .8, texelSize: txs }); fbo.pres.swap();
    for (let i = 0; i < E.iters; i++) { run(E.P.pressure, fbo.pres.write, { uPressure: fbo.pres.read, uDivergence: fbo.div, texelSize: txs }); fbo.pres.swap(); }
    run(E.P.gradient, vel.write, { uPressure: fbo.pres.read, uVelocity: vel.read, texelSize: txs }); vel.swap();
    run(E.P.advect, vel.write, { uVelocity: vel.read, uSource: vel.read, dt, dissipation: .4 + fade * .5, texelSize: txs }); vel.swap();
    run(E.P.advect, dye.write, { uVelocity: vel.read, uSource: dye.read, dt, dissipation: fade, texelSize: txs }); dye.swap();
    if (moving && tex && hostInfo) {
      const amt = clamp(seg / 7, .12, 1) * .95 * inten * O.density;                            // smoke per distance travelled: lingering never piles up into dark patches
      run(E.P.splatDye, dye.write, { ...stroke, uTarget: dye.read, uAtlas: tex, uCell: cell.cell, uFlowH: cell.flowH ? 1 : 0, uFlip: ribbon.flip, uAmt: amt, uLen: hi.width * cell.len, texelSize: dye.tx }); dye.swap();
    }
    run(E.P.path, path.write, { ...stroke, uD: path.read, uHeal: Math.exp(-dt / (moving ? .5 : .24)), texelSize: path.tx }); path.swap();
    if (touching && hi.edgeA > 0) { run(E.P.edgeInk, dye.write, { ...stroke, uTarget: dye.read, uD: path.read, texelSize: dye.tx }); dye.swap(); }
    run(E.P.display, null, { uDye: dye.read, uD: path.read, uCanvas: [E.canvas.width, E.canvas.height], uSmoke: theme === 'light' ? O.lightSmoke : O.darkSmoke, uPage: page, uDark: theme === 'dark' ? 1 : 0, uEdgeCol: edgeCol, uView: [E.W, E.H], uRect: dispRect.rect, uCorner: dispRect.corner, uEdgeW: dispRect.edgeW, uEdgeA: dispRect.edgeA, uIsText: dispRect.isText || 0, uGlyph: E.glyphTex, uTime: simT, texelSize: dye.tx });
    if (alive && now - idleSince < 1400) raf = requestAnimationFrame(frame);       // ~1.4 s after the last movement everything is clear: sleep
    else E.reset();
  }
  function wake() { if (alive && !raf && E) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  function ensure() {
    if (E === false) return false;
    if (!E) {
      try { E = makeEngine() || false; } catch (e) { console.warn('[smoke-hover] disabled:', e.message); E = false; }
      if (!E) return false;
      document.body.appendChild(E.canvas);
      const { gl } = E, cv = makeAtlas(), t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      E.atlasTex = t;
    }
    return true;
  }

  /* ------------------------------------------------------------------ magnetic float: the hovered element leans toward the cursor */
  // the innermost floating element under the cursor leans toward it (small things a little more, big containers barely)
  const floats = new Map(); let fraf = 0, fl = 0;
  function floatTick(now) {
    fraf = 0; const dt = Math.min((now - (fl || now)) / 1000, 1 / 30); fl = now;
    for (const [el, f] of floats) {
      // critically damped spring: smooth, no wobble
      const k = 1 - Math.exp(-dt * 11);
      f.x += (f.tx - f.x) * k; f.y += (f.ty - f.y) * k;
      if (!el.isConnected || (!f.on && Math.abs(f.x) + Math.abs(f.y) < .05)) { el.style.translate = ''; floats.delete(el); continue; }
      el.style.translate = `${f.x.toFixed(2)}px ${f.y.toFixed(2)}px`;
    }
    if (floats.size) fraf = requestAnimationFrame(floatTick); else fl = 0;
  }
  function floatTo(el, cx, cy) {
    for (const [o, f] of floats) if (o !== el) { f.on = false; f.tx = f.ty = 0; }
    if (el) {
      const r = el.getBoundingClientRect(), f = floats.get(el) || { x: 0, y: 0, tx: 0, ty: 0 };
      const ox = parseFloat(el.style.translate) || 0, oy = parseFloat((el.style.translate || '').split(' ')[1]) || 0;
      const mx = r.left - ox + r.width / 2, my = r.top - oy + r.height / 2;
      const big = r.width * r.height > 160000;                                  // panels, tables, dialogs: just a breath of movement
      const max = big ? 1.4 : clamp(Math.min(r.width, r.height) * .08, 1.5, 4.5); // a few px at most: felt, never seen as layout movement
      f.on = true; f.tx = clamp((cx - mx) / (r.width / 2), -1, 1) * max; f.ty = clamp((cy - my) / (r.height / 2), -1, 1) * max;
      floats.set(el, f);
    }
    if (!fraf && floats.size) fraf = requestAnimationFrame(floatTick);
  }

  /* ------------------------------------------------------------------ input */
  const onFloat = e => { if (!O.float || e.pointerType !== 'mouse') return; const n = e.target; floatTo(n && n.closest ? n.closest(O.floatSelector) : null, e.clientX, e.clientY); };
  // one place that handles a pointer position, whether it came from a mouse, a finger, or drive()
  // text only counts over its words, not the empty part of its line box; if the pointer is beside the words, look further out
  function hostAt(n, x, y) {
    let el = n && n.closest ? n.closest(SEL) : null;
    while (el && el.matches(TEXTY)) {
      const r = rectOf(el);
      if (x > r.left - 10 && x < r.right + 10 && y > r.top - 8 && y < r.bottom + 8) break;
      el = el.parentElement ? el.parentElement.closest(SEL) : null;
    }
    return el;
  }
  function track(x, y, tg, fresh) {
    let el = hostAt(tg, x, y);
    if (!el) for (const [dx, dy] of [[18, 0], [-18, 0], [0, 18], [0, -18]]) {   // near an edge counts: the smoke can lick it from outside
      const n = document.elementFromPoint(x + dx, y + dy); el = hostAt(n, x + dx, y + dy); if (el) break; }
    if (fresh || P.x < -9000 || el !== host) { P.px = x; P.py = y; }   // never draw a stroke across the gap between elements
    P.x = x; P.y = y;
    host = el;
    if (!el && !E) return;                       // nothing hovered yet: don't even start the engine
    if (!ensure()) return;
    idleSince = performance.now(); wake();
  }
  let driving = false, touching = false;
  const onMove = e => { if (e.pointerType !== 'mouse') return; driving = false; track(e.clientX, e.clientY, e.target); };
  const onTouch = e => { const p = e.touches && e.touches[0]; if (!p) return; driving = false;
    const fresh = e.type === 'touchstart'; touching = true; track(p.clientX, p.clientY, document.elementFromPoint(p.clientX, p.clientY), fresh); };
  const onTouchEnd = e => { if (!e.touches || !e.touches.length) { touching = false; host = null; } };
  if (O.touch) {
    addEventListener('touchstart', onTouch, { passive: true }); addEventListener('touchmove', onTouch, { passive: true });
    addEventListener('touchend', onTouchEnd, { passive: true }); addEventListener('touchcancel', onTouchEnd, { passive: true });
  }
  const onLeave = () => { host = null; floatTo(null); };
  const onBlur = () => { host = null; };
  const onResize = () => { if (E) E.resize(); };
  const onScroll = () => { if (E && raf && !touching && !driving) E.reset(); };   // smoke lives in screen space: clear it when the page scrolls under it
  addEventListener('pointermove', onFloat, { passive: true });
  addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave, { passive: true });
  addEventListener('blur', onBlur);
  addEventListener('resize', onResize, { passive: true });
  addEventListener('scroll', onScroll, { passive: true });

  // theme: light or dark smoke, and the page colour the UI "gives way" to
  let theme = 'light';
  function pageColor() {
    for (const el of [document.body, root]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] > .05)) return [m[0] / 255, m[1] / 255, m[2] / 255];
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? [.04, .04, .04] : [1, 1, 1];
  }
  function readTheme() {
    page = pageColor();
    const lum = .2126 * page[0] + .7152 * page[1] + .0722 * page[2];
    theme = O.theme === 'light' || O.theme === 'dark' ? O.theme : (lum > .5 ? 'light' : 'dark');
    if (E) E.reset();
  }
  readTheme();
  const mo = new MutationObserver(readTheme);
  mo.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  const mq = matchMedia('(prefers-color-scheme: dark)'), onScheme = () => setTimeout(readTheme, 0);
  mq.addEventListener && mq.addEventListener('change', onScheme);

  function destroy() {
    if (!alive) return; alive = false;
    if (raf) cancelAnimationFrame(raf); if (fraf) cancelAnimationFrame(fraf);
    removeEventListener('pointermove', onFloat); removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave); removeEventListener('blur', onBlur);
    removeEventListener('resize', onResize); removeEventListener('scroll', onScroll);
    removeEventListener('touchstart', onTouch); removeEventListener('touchmove', onTouch);
    removeEventListener('touchend', onTouchEnd); removeEventListener('touchcancel', onTouchEnd);
    mo.disconnect(); mq.removeEventListener && mq.removeEventListener('change', onScheme);
    for (const [el] of floats) el.style.translate = ''; floats.clear();
    if (E) { E.canvas.remove(); const lose = E.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    E = false;
  }
  return { running: true, destroy, setTheme(th) { O.theme = th || 'auto'; readTheme(); },
    // steer the smoke yourself (autoplay demos, touch screens): it smokes whatever element is at (x, y)
    drive(x, y) { const fresh = !driving; driving = true; track(x, y, document.elementFromPoint(x, y), fresh); },
    release() { driving = false; host = null; } };
  }

  const api = { init, defaults: DEFAULTS, version: '1.0.0' };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.SmokeHover = api;
})(typeof window !== 'undefined' ? window : this);
