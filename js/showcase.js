// SCREEN 4: HOLO SHOWCASE
// 3D-flippable card with a WebGL renderer that interpolates between the
// 5 captured tilt textures per side, so the card's actual hologram
// behaviour is reproduced — not a CSS pseudo-effect.

const holoFlip = document.getElementById('holoFlip');
const holoCard = document.getElementById('holoCard');
const holoFrontCanvas = document.getElementById('holoFrontCanvas');
const holoBackCanvas = document.getElementById('holoBackCanvas');
const holoCardImgFront = document.getElementById('holoCardImgFront');
const holoCardImgBack = document.getElementById('holoCardImgBack');
const holoPattern = document.getElementById('holoPattern');
const holoSparkle = document.getElementById('holoSparkle');
const holoGlare = document.getElementById('holoGlare');
const holoRainbow = document.getElementById('holoRainbow');

let flipped = false;
let lastTilt = { mx: 0.5, my: 0.5 };
let frontRenderer = null;  // { gl, program, textures, render(tilt) }
let backRenderer  = null;

function framesComplete(frames) {
  return frames && ['center','left','right','up','down'].every(k => !!frames[k]);
}

function initShowcase() {
  flipped = false;
  holoCard.style.setProperty('--flip', '0deg');

  const useMV_front = framesComplete(state.frontFrames);
  const useMV_back  = framesComplete(state.backFrames);

  // Hide CSS pseudo-holo whenever we have any real multi-view data
  const realHolo = useMV_front || useMV_back;
  [holoPattern, holoRainbow, holoSparkle, holoGlare].forEach(el => {
    el.style.display = realHolo ? 'none' : '';
  });

  // ── Front face ──
  if (useMV_front) {
    holoFrontCanvas.hidden = false;
    holoCardImgFront.hidden = true;
    frontRenderer = createMultiViewRenderer(holoFrontCanvas, state.frontFrames);
    frontRenderer.render(0, 0);
  } else {
    holoFrontCanvas.hidden = true;
    holoCardImgFront.hidden = false;
    const src = state.frontCard || state.rectifiedCanvas;
    if (src) holoCardImgFront.style.backgroundImage = `url(${src.toDataURL('image/png')})`;
  }

  // ── Back face ──
  if (useMV_back) {
    holoBackCanvas.hidden = false;
    holoCardImgBack.hidden = true;
    backRenderer = createMultiViewRenderer(holoBackCanvas, state.backFrames);
    backRenderer.render(0, 0);
  } else {
    holoBackCanvas.hidden = true;
    holoCardImgBack.hidden = false;
    if (state.backCard) {
      holoCardImgBack.style.backgroundImage = `url(${state.backCard.toDataURL('image/png')})`;
    } else {
      holoCardImgBack.style.background =
        'linear-gradient(135deg, #1a1a1a, #0a0a0a) center/cover no-repeat';
    }
  }
}

// ─────── Multi-view WebGL renderer ───────
// Uploads 5 textures (center + left/right/up/down) and a fragment shader that
// blends them weighted by the current tilt vector. Result: as the user moves
// their pointer / tilts their phone, the card surface shows the actual color
// it had at that viewing angle during capture — including real holo shimmer.
const VERT_SRC = `
  attribute vec2 a_pos;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;
const FRAG_SRC = `
  precision highp float;
  uniform sampler2D u_center;
  uniform sampler2D u_left;
  uniform sampler2D u_right;
  uniform sampler2D u_up;
  uniform sampler2D u_down;
  uniform vec2 u_tilt; // x,y in roughly -1..+1
  varying vec2 v_uv;
  void main() {
    vec4 c = texture2D(u_center, v_uv);
    vec4 l = texture2D(u_left,   v_uv);
    vec4 r = texture2D(u_right,  v_uv);
    vec4 u = texture2D(u_up,     v_uv);
    vec4 d = texture2D(u_down,   v_uv);
    float tx = clamp(u_tilt.x, -1.0, 1.0);
    float ty = clamp(u_tilt.y, -1.0, 1.0);
    // Triangle weights so the 5 textures form a partition of unity on the
    // (tx,ty) square in [-1,1]^2 — center owns the middle, the four tilt
    // captures own their respective edges.
    float wL = max(0.0, -tx);
    float wR = max(0.0,  tx);
    float wU = max(0.0, -ty);
    float wD = max(0.0,  ty);
    float wC = max(0.0, 1.0 - abs(tx) - abs(ty));
    float total = wC + wL + wR + wU + wD;
    if (total < 1e-4) { gl_FragColor = c; return; }
    gl_FragColor = (c * wC + l * wL + r * wR + u * wU + d * wD) / total;
  }
`;

function createMultiViewRenderer(canvas, frames) {
  canvas.width = frames.center.width;
  canvas.height = frames.center.height;
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) {
    console.warn('[showcase] WebGL not available, falling back to center frame only');
    const ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(frames.center, 0, 0);
    return { render() {} };
  }

  // Compile + link
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('shader error:', gl.getShaderInfoLog(sh));
    }
    return sh;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('link error:', gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  // Full-screen quad. Flip Y on the UV side so the canvas isn't upside-down.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    // x,    y,    u,   v
    -1, -1,   0, 1,
     1, -1,   1, 1,
    -1,  1,   0, 0,
     1,  1,   1, 0,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  const aUv  = gl.getAttribLocation(prog, 'a_uv');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv,  2, gl.FLOAT, false, 16, 8);

  // Upload 5 textures
  function makeTex(source, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
  }
  const slots = ['center','left','right','up','down'];
  slots.forEach((name, i) => {
    makeTex(frames[name], i);
    const loc = gl.getUniformLocation(prog, 'u_' + name);
    gl.uniform1i(loc, i);
  });
  const uTilt = gl.getUniformLocation(prog, 'u_tilt');

  function render(tx, ty) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uTilt, tx, ty);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return { render };
}

// Mouse / pointer tilt
function setTilt(mx, my, rect) {
  lastTilt.mx = mx; lastTilt.my = my;
  // mx, my in 0..1
  const rx = (0.5 - my) * 22; // rotateX
  const ry = (mx - 0.5) * 22; // rotateY
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.setProperty('--rx', rx + 'deg');
  holoCard.style.setProperty('--ry', ry + 'deg');
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  holoCard.style.transform = `rotateX(${rx}deg) rotateY(${ry + flipDeg}deg)`;

  // Multi-view holo: ask each WebGL renderer to redraw with the current tilt
  // as a (-1..+1) vector. mx=0 → left, mx=1 → right (so tx = (mx-0.5)*2).
  const tx = (mx - 0.5) * 2;
  const ty = (my - 0.5) * 2;
  if (frontRenderer) frontRenderer.render(tx, ty);
  if (backRenderer)  backRenderer.render(tx, ty);

  // Move highlight position
  const mxPct = (mx * 100).toFixed(1) + '%';
  const myPct = (my * 100).toFixed(1) + '%';
  holoCard.style.setProperty('--mx', mxPct);
  holoCard.style.setProperty('--my', myPct);
  holoCard.style.setProperty('--bgx', (mx * 100).toFixed(1) + '%');
  holoCard.style.setProperty('--bgy', (my * 100).toFixed(1) + '%');

  // Glare angle
  const angle = (Math.atan2(my - 0.5, mx - 0.5) * 180 / Math.PI + 90 + 360) % 360;
  holoCard.style.setProperty('--angle', angle + 'deg');
  holoCard.style.setProperty('--ang2', (angle * 2) + 'deg');

  // Glare intensity proportional to distance from center
  const dist = Math.hypot(mx-0.5, my-0.5) * 2;
  holoCard.style.setProperty('--shine', (0.4 + dist * 0.5).toFixed(2));
  holoCard.style.setProperty('--glare', (0.3 + dist * 0.5).toFixed(2));
}

function onPointerMove(e) {
  const rect = holoCard.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  const x = (t.clientX - rect.left) / rect.width;
  const y = (t.clientY - rect.top) / rect.height;
  if (x < -0.3 || x > 1.3 || y < -0.3 || y > 1.3) return;
  holoCard.classList.remove('float');
  setTilt(Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)));
}
function onPointerLeave() {
  holoCard.classList.add('float');
  // Reset transform but preserve flip state via CSS variable so the float
  // animation keeps the card oriented correctly.
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
}

// Tap / click the card to flip it. The float animation keeps using --flip so
// the orientation stays right while idle.
function toggleFlip() {
  flipped = !flipped;
  const flipDeg = flipped ? 180 : 0;
  holoCard.classList.add('float'); // re-engage float so transition smooths
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  // Direct transform so the 0.5s ease transition kicks in even mid-tilt
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
  // Hide the hint after the first flip
  const hint = document.getElementById('holoFlipHint');
  if (hint) hint.style.opacity = '0';
}
holoFlip.addEventListener('click', toggleFlip);

document.getElementById('screen-showcase').addEventListener('mousemove', onPointerMove);
document.getElementById('screen-showcase').addEventListener('mouseleave', onPointerLeave);
holoCard.addEventListener('touchmove', onPointerMove, {passive: true});

// Gyroscope
document.getElementById('enableGyro').addEventListener('click', async () => {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') startGyro();
    } catch(e) {}
  } else {
    startGyro();
  }
});

function startGyro() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta === null || e.gamma === null) return;
    holoCard.classList.remove('float');
    const x = Math.max(0, Math.min(1, 0.5 + (e.gamma / 60)));
    const y = Math.max(0, Math.min(1, 0.5 + ((e.beta - 30) / 60)));
    setTilt(x, y); // setTilt already folds flip into the transform
  });
}

// Holo style switching
document.querySelectorAll('.holo-style').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.holo-style').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyHoloStyle(btn.dataset.style);
  });
});

function applyHoloStyle(style) {
  // Adjust holo pattern bg + opacity
  switch(style) {
    case 'cosmos':
      holoPattern.style.background =
        `repeating-linear-gradient(115deg,
          rgba(255,0,128,0.0) 0%, rgba(255,0,128,0.4) 5%,
          rgba(255,200,0,0.4) 10%, rgba(0,255,200,0.4) 15%,
          rgba(50,100,255,0.4) 20%, rgba(255,0,128,0.0) 25%)`;
      holoPattern.style.opacity = '0.6';
      holoRainbow.style.opacity = '0.4';
      break;
    case 'rainbow':
      holoPattern.style.background =
        `repeating-linear-gradient(90deg,
          rgba(255,0,0,0.5) 0%, rgba(255,165,0,0.5) 14%,
          rgba(255,255,0,0.5) 28%, rgba(0,255,0,0.5) 42%,
          rgba(0,127,255,0.5) 56%, rgba(127,0,255,0.5) 70%,
          rgba(255,0,0,0.5) 100%)`;
      holoPattern.style.opacity = '0.75';
      holoRainbow.style.opacity = '0.55';
      break;
    case 'gold':
      holoPattern.style.background =
        `repeating-linear-gradient(105deg,
          rgba(212,175,106,0.0) 0%, rgba(240,204,127,0.6) 6%,
          rgba(255,235,160,0.6) 12%, rgba(212,175,106,0.4) 18%,
          rgba(180,140,60,0.4) 24%, rgba(212,175,106,0.0) 30%)`;
      holoPattern.style.opacity = '0.7';
      holoRainbow.style.opacity = '0.2';
      break;
    case 'subtle':
      holoPattern.style.background =
        `linear-gradient(120deg,
          rgba(255,255,255,0.0) 30%, rgba(255,255,255,0.3) 50%,
          rgba(255,255,255,0.0) 70%)`;
      holoPattern.style.opacity = '0.35';
      holoRainbow.style.opacity = '0.1';
      break;
  }
}
