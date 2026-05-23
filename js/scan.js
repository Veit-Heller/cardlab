// SCREEN 1: SCAN
// Two-stage capture (front + back). The live camera stream is preview-only —
// it shows the user where their card is detected so they can frame it well.
// The actual high-resolution capture uses <input type="file" capture="environment">
// which on iOS Safari triggers the *native* camera UI and returns a full
// 12MP+ still — far better than what getUserMedia gives us (capped at 1080p).

const scanWelcome = document.getElementById('scanWelcome');
const scanStage = document.getElementById('scanStage');
const scanVideo = document.getElementById('scanVideo');
const scanOverlay = document.getElementById('scanOverlay');
const scanInstruction = document.getElementById('scanInstruction');
const scannerWrap = document.querySelector('.scanner-wrap');
const btnCaptureCard = document.getElementById('btnCaptureCard');

const scanner = {
  stream: null,
  running: false,
  rafId: null,
  lastFrameTime: 0,
  lastCvDispatchAt: 0,
  cvInterval: 200,
  cvBusy: false,
  cvSeq: 0,
  lastQuality: {
    detect: 0, sharp: 0, light: 0, frame: 0, glare: 0,
    quad: null, quadScale: 1, sharpness: 0, coverage: 0,
  },
  // Stability tracking — last N quads in video coords. Auto-snap fires when
  // every corner stayed within STABLE_RADIUS px of the recent median for
  // STABLE_DURATION_MS.
  quadHistory: [],            // array of { t, quad: [{x,y}*4 in video coords] }
  stableSinceMs: 0,           // first timestamp the quad was confirmed stable
  lastAutoSnapAt: 0,          // throttle so we don't fire twice
};

const STABLE_HISTORY_MS = 1200;   // keep ~last 1.2 s of quads
const STABLE_DURATION_MS = 900;   // require quad steady this long
const STABLE_RADIUS_PX = 18;      // max corner jitter (video pixels)
const AUTO_SNAP_COOLDOWN_MS = 2500;

// ─────── OpenCV Worker ───────
let cvWorker = null;
let cvWorkerReady = false;
function setupCvWorker() {
  if (cvWorker) return;
  cvWorker = new Worker('js/cv-worker.js');
  cvWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') {
      cvWorkerReady = true;
    } else if (m.type === 'detect-result') {
      scanner.cvBusy = false;
      handleCvResult(m.id, m.quad);
    } else if (m.type === 'detect-error') {
      scanner.cvBusy = false;
      console.warn('[cv-worker]', m.message);
    }
  };
  cvWorker.onerror = (e) => {
    scanner.cvBusy = false;
    console.warn('[cv-worker error]', e.message || e);
  };
}

// One-shot detection helper (Promise-based) — used after the high-res snap.
function detectInImage(canvas) {
  return new Promise((resolve, reject) => {
    if (!cvWorkerReady) { reject(new Error('cv worker not ready')); return; }
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const id = ++scanner.cvSeq;
    const handler = (e) => {
      const m = e.data;
      if (m.id === id && m.type === 'detect-result') {
        cvWorker.removeEventListener('message', handler);
        resolve(m.quad);
      } else if (m.id === id && m.type === 'detect-error') {
        cvWorker.removeEventListener('message', handler);
        reject(new Error(m.message));
      }
    };
    cvWorker.addEventListener('message', handler);
    cvWorker.postMessage(
      { type: 'detect', id, rgba: img.data, w: canvas.width, h: canvas.height },
      [img.data.buffer]
    );
    setTimeout(() => {
      cvWorker.removeEventListener('message', handler);
      reject(new Error('cv worker timeout'));
    }, 8000);
  });
}

// ─────── Two-stage capture state ───────
const SIDE_LABEL = { front: 'Vorderseite', back: 'Rückseite' };
const CARD_OUT_W = 1500;
const CARD_OUT_H = 2100;

const capture = {
  side: 'front',
  finished: false,
  busy: false, // true while processing a snap
};
function resetCapture() {
  capture.side = 'front';
  capture.finished = false;
  capture.busy = false;
}
resetCapture();

// ─────── Camera setup ───────
// We request the highest resolution the device will actually give us so the
// final snap is as high-res as possible (not a hard-coded 1080p cap).
// Strategy:
//   1. Ask for 4K with `ideal` — the browser will give us the best it can.
//   2. After the stream is live, query `getCapabilities()` and `applyConstraints()`
//      to push to the device-reported maximum (often higher than the initial grant).
async function startScan() {
  scanWelcome.style.display = 'none';
  scanStage.style.display = 'block';
  resetCapture();

  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
  } catch (err) {
    alert('Kamera-Zugriff verweigert.\n\n' + err.message +
          '\n\nDie Seite muss über https:// oder localhost laufen.');
    stopScan(false);
    return;
  }

  // Try to push to the device-reported maximum resolution after the stream is up.
  const track = scanner.stream.getVideoTracks()[0];
  if (track && typeof track.getCapabilities === 'function') {
    try {
      const caps = track.getCapabilities();
      if (caps.width && caps.height) {
        await track.applyConstraints({
          width:  { ideal: caps.width.max  },
          height: { ideal: caps.height.max },
        });
      }
    } catch (e) {
      // Some browsers reject applyConstraints — that's OK, we'll use what we got.
      console.warn('[scan] applyConstraints rejected:', e.message || e);
    }
  }

  setupCvWorker();
  scanVideo.srcObject = scanner.stream;
  await scanVideo.play().catch(() => {});
  if (!scanVideo.videoWidth) {
    await new Promise(r => scanVideo.addEventListener('loadedmetadata', r, { once: true }));
  }
  resizeOverlay();
  window.addEventListener('resize', resizeOverlay);

  // Log what we actually got — surfaces in the debug strip so we can see if
  // the device gave us a real high-res stream or capped us.
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  setDebug(`stream: ${settings.width || scanVideo.videoWidth}×${settings.height || scanVideo.videoHeight}`);

  scanner.running = true;
  scanner.lastFrameTime = performance.now();
  loop();
}

function resizeOverlay() {
  const r = scanVideo.getBoundingClientRect();
  scanOverlay.width = r.width;
  scanOverlay.height = r.height;
}

function stopScan(skipUI = false) {
  scanner.running = false;
  if (scanner.rafId) cancelAnimationFrame(scanner.rafId);
  if (scanner.stream) {
    scanner.stream.getTracks().forEach(t => t.stop());
    scanner.stream = null;
  }
  scanVideo.srcObject = null;
  if (!skipUI) {
    scanStage.style.display = 'none';
    scanWelcome.style.display = 'block';
  }
}

// ─────── Live loop ───────
// All capture decisions happen inside the loop — no user button required.
// When quad + sharpness + stability + low-glare are all satisfied, auto-snap
// fires; the snap-now button below is a manual escape hatch only.
function loop() {
  if (!scanner.running) return;
  try {
    const now = performance.now();
    scanner.lastFrameTime = now;
    runDetectionStep();
    drawScanOverlay();
    updateInstruction();
    updateDebug();
    updateCaptureButton();
    maybeAutoSnap(now);
  } catch (e) {
    setDebug('loop-err: ' + (e.message || e));
    console.error('[scan loop]', e);
  }
  scanner.rafId = requestAnimationFrame(loop);
}

// All five gates must pass for auto-snap to fire.
function autoSnapGates() {
  const q = scanner.lastQuality;
  return {
    cv:        cvWorkerReady,
    detect:    q.detect >= 0.99,
    sharp:     q.sharp >= 0.30,            // looser than the old 0.45
    light:     q.light >= 0.25,
    frame:     q.frame >= 0.55,
    aspect:    q.frame >= 0.55,            // framingScore already weights aspect
    glareOk:   q.glare < 0.06,             // <6% near-white pixels in card area
    stable:    isQuadStable(),
  };
}

function allGatesPass(g) {
  return g.cv && g.detect && g.sharp && g.light && g.frame && g.glareOk && g.stable;
}

function maybeAutoSnap(now) {
  if (capture.busy) return;
  if (now - scanner.lastAutoSnapAt < AUTO_SNAP_COOLDOWN_MS) return;
  const g = autoSnapGates();
  if (allGatesPass(g)) {
    scanner.lastAutoSnapAt = now;
    captureHiRes();
  }
}

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

function runDetectionStep() {
  if (!scanVideo.videoWidth) return;
  const now = performance.now();
  if (now - scanner.lastCvDispatchAt < scanner.cvInterval) return;
  if (scanner.cvBusy || !cvWorkerReady) return;

  const TARGET = 480;
  const vw = scanVideo.videoWidth, vh = scanVideo.videoHeight;
  const s = Math.min(1, TARGET / Math.max(vw, vh));
  const dw = Math.round(vw * s), dh = Math.round(vh * s);
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  detectCtx.drawImage(scanVideo, 0, 0, dw, dh);
  const imgData = detectCtx.getImageData(0, 0, dw, dh);
  const { mean, stddev } = brightnessStats(imgData);
  const sharpness = laplacianVariance(imgData);

  scanner.lastQuality.sharp = clamp(sharpness / 600, 0, 1);
  scanner.lastQuality.light = clamp((mean - 30) / 140, 0, 1) * clamp(stddev / 50, 0, 1);
  scanner.lastQuality.sharpness = sharpness;
  scanner.lastQuality.mean = mean;
  scanner.lastQuality.stddev = stddev;
  scanner.lastQuality.quadScale = 1 / s;

  scanner.lastCvDispatchAt = now;
  scanner.cvBusy = true;
  scanner.cvSeq++;
  cvWorker.postMessage(
    { type: 'detect', id: scanner.cvSeq, rgba: imgData.data, w: dw, h: dh },
    [imgData.data.buffer]
  );
}

function handleCvResult(_id, quad) {
  scanner.lastQuality.quad = quad;
  scanner.lastQuality.detect = quad ? 1 : 0;
  if (quad) {
    scanner.lastQuality.coverage = quadAreaRatio(quad, detectCanvas.width, detectCanvas.height);
    scanner.lastQuality.frame = framingScore(quad, detectCanvas.width, detectCanvas.height);
    scanner.lastQuality.glare = glareRatio(quad);
    // Push quad (in video coords) into stability history
    const qs = scanner.lastQuality.quadScale;
    const videoQuad = quad.map(p => ({ x: p.x * qs, y: p.y * qs }));
    const now = performance.now();
    scanner.quadHistory.push({ t: now, quad: videoQuad });
    while (scanner.quadHistory.length > 0 &&
           now - scanner.quadHistory[0].t > STABLE_HISTORY_MS) {
      scanner.quadHistory.shift();
    }
  } else {
    scanner.lastQuality.coverage = 0;
    scanner.lastQuality.frame = 0;
    scanner.lastQuality.glare = 0;
    scanner.quadHistory.length = 0;
    scanner.stableSinceMs = 0;
  }
}

// Glare ratio: fraction of pixels inside the detected quad whose luminance
// is in specular-highlight territory (>= 245). Bigger = more reflection,
// auto-capture should hold off so we don't snap a hazy frame.
function glareRatio(quadDetect) {
  // Sample the detect canvas at quad-bounded coords. Cheap bounding-box
  // approximation rather than a real polygon mask — fine for a gate.
  try {
    const W = detectCanvas.width, H = detectCanvas.height;
    const ctx = detectCanvas.getContext('2d');
    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    quadDetect.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    minX = Math.max(0, minX | 0); maxX = Math.min(W-1, maxX | 0);
    minY = Math.max(0, minY | 0); maxY = Math.min(H-1, maxY | 0);
    let hot = 0, total = 0;
    for (let y = minY; y <= maxY; y += 3) {
      for (let x = minX; x <= maxX; x += 3) {
        const i = (y * W + x) * 4;
        const lum = (data[i] + data[i+1] + data[i+2]) / 3;
        if (lum >= 245) hot++;
        total++;
      }
    }
    return total > 0 ? hot / total : 0;
  } catch (e) {
    return 0;
  }
}

// Have the last STABLE_DURATION_MS of quads stayed within STABLE_RADIUS_PX
// per corner? If so, the user is holding steady and we can snap.
function isQuadStable() {
  const hist = scanner.quadHistory;
  if (hist.length < 4) return false;
  const now = performance.now();
  // Look at the window: must span at least STABLE_DURATION_MS
  if (now - hist[0].t < STABLE_DURATION_MS) return false;
  // Compute per-corner max deviation from the most recent quad
  const ref = hist[hist.length - 1].quad;
  for (let i = 0; i < 4; i++) {
    let maxDev = 0;
    for (let j = 0; j < hist.length; j++) {
      const p = hist[j].quad[i];
      const d = Math.hypot(p.x - ref[i].x, p.y - ref[i].y);
      if (d > maxDev) maxDev = d;
    }
    if (maxDev > STABLE_RADIUS_PX) return false;
  }
  return true;
}

// ─────── Quality math (cheap, on main thread) ───────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function brightnessStats(imgData) {
  const d = imgData.data;
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < d.length; i += 32) {
    const b = (d[i] + d[i+1] + d[i+2]) / 3;
    sum += b; sumSq += b*b; n++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean*mean;
  return { mean, stddev: Math.sqrt(Math.max(0, variance)) };
}

function laplacianVariance(imgData) {
  const W = imgData.width, H = imgData.height;
  const d = imgData.data;
  const gray = new Float32Array(W*H);
  for (let i = 0; i < W*H; i++) gray[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < H-1; y += 3) {
    for (let x = 1; x < W-1; x += 3) {
      const c = gray[y*W + x];
      const lap = 4*c - gray[(y-1)*W + x] - gray[(y+1)*W + x] - gray[y*W + (x-1)] - gray[y*W + (x+1)];
      sum += lap; sumSq += lap*lap; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean*mean;
}

function quadAreaRatio(quad, W, H) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i], q = quad[(i+1) % 4];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2 / (W * H);
}

function framingScore(quad, W, H) {
  const area = quadAreaRatio(quad, W, H);
  let coverageScore;
  if (area < 0.25) coverageScore = area / 0.25 * 0.5;
  else if (area < 0.45) coverageScore = 0.5 + (area - 0.25) / 0.20 * 0.5;
  else if (area < 0.75) coverageScore = 1.0;
  else if (area < 0.95) coverageScore = 1.0 - (area - 0.75) / 0.20 * 0.4;
  else coverageScore = 0.6 - (area - 0.95) / 0.05 * 0.6;
  coverageScore = clamp(coverageScore, 0, 1);
  const cx = quad.reduce((s,p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s,p) => s + p.y, 0) / 4;
  const dxNorm = Math.abs(cx - W/2) / (W/2);
  const dyNorm = Math.abs(cy - H/2) / (H/2);
  const centerScore = clamp(1 - (dxNorm + dyNorm), 0, 1);
  const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const ratio = Math.min(w, h) / Math.max(w, h);
  const ratioScore = clamp(1 - Math.abs(ratio - 0.714) * 3, 0, 1);
  return coverageScore * 0.5 + centerScore * 0.3 + ratioScore * 0.2;
}

// ─────── Overlay rendering ───────
// Outline colour reflects state:
//   yellow  = card detected, not yet good (quality / framing / glare problem)
//   cyan    = quality good but not yet stable enough to capture
//   green pulsing = stable, auto-snap imminent
function drawScanOverlay() {
  const ctx = scanOverlay.getContext('2d');
  ctx.clearRect(0, 0, scanOverlay.width, scanOverlay.height);
  const q = scanner.lastQuality.quad;
  if (!q) return;

  const vw = scanVideo.videoWidth, vh = scanVideo.videoHeight;
  const ow = scanOverlay.width, oh = scanOverlay.height;
  const videoAspect = vw / vh;
  const overlayAspect = ow / oh;
  let scale, offX, offY;
  if (videoAspect > overlayAspect) {
    scale = oh / vh; offX = (ow - vw * scale) / 2; offY = 0;
  } else {
    scale = ow / vw; offX = 0; offY = (oh - vh * scale) / 2;
  }
  const qs = scanner.lastQuality.quadScale;
  const qualOk = isQualityGood();
  const stable = qualOk && isQuadStable();

  let stroke, glow, dot;
  if (stable) {
    // Pulse green when about to fire
    const t = (performance.now() % 800) / 800;
    const alpha = 0.7 + 0.3 * Math.sin(t * Math.PI * 2);
    stroke = `rgba(95,220,140,${alpha.toFixed(2)})`;
    glow = 'rgba(95,220,140,0.8)';
    dot = '#5fdc8c';
  } else if (qualOk) {
    stroke = 'rgba(106,255,227,0.9)';
    glow = 'rgba(106,255,227,0.5)';
    dot = '#6affe3';
  } else {
    stroke = 'rgba(240,204,127,0.85)';
    glow = 'rgba(240,204,127,0.4)';
    dot = '#f0cc7f';
  }

  ctx.beginPath();
  q.forEach((p, i) => {
    const ox = p.x * qs * scale + offX;
    const oy = p.y * qs * scale + offY;
    if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
  });
  ctx.closePath();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = stable ? 4 : 3;
  ctx.shadowColor = glow;
  ctx.shadowBlur = stable ? 18 : 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  q.forEach(p => {
    const ox = p.x * qs * scale + offX;
    const oy = p.y * qs * scale + offY;
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(ox, oy, stable ? 7 : 5, 0, Math.PI*2);
    ctx.fill();
  });
}

// ─────── Quality gate + UI updates ───────
function isQualityGood() {
  const q = scanner.lastQuality;
  return q.detect >= 0.99 && q.light >= 0.30 && q.frame >= 0.50;
}

function updateInstruction() {
  if (capture.busy) {
    scanInstruction.textContent = '📸 Foto wird verarbeitet…';
    scanInstruction.classList.add('good');
    return;
  }
  const q = scanner.lastQuality;
  const sideLabel = SIDE_LABEL[capture.side];
  let msg, good = false;

  if (!cvWorkerReady) {
    msg = 'Initialisiere Detektor…';
  } else if (q.detect < 0.99) {
    msg = `${sideLabel} ins Bild halten`;
  } else if (q.light < 0.25) {
    msg = 'Mehr Licht bitte';
  } else if (q.glare >= 0.06) {
    msg = 'Licht spiegelt · Karte leicht kippen';
  } else if (q.frame < 0.55) {
    if (q.coverage < 0.25) msg = 'Näher ran an die Karte';
    else if (q.coverage > 0.85) msg = 'Etwas weiter weg';
    else msg = 'Karte mittig halten';
  } else if (q.sharp < 0.30) {
    msg = 'Ruhig halten · Fokus';
  } else if (!isQuadStable()) {
    msg = `${sideLabel} ruhig halten…`;
    good = true;
  } else {
    msg = '✨ Halten…';
    good = true;
  }
  scanInstruction.textContent = msg;
  scanInstruction.classList.toggle('good', good);
}

function updateCaptureButton() {
  if (!btnCaptureCard) return;
  // Manual capture button is now an escape hatch — present but secondary,
  // because in the normal flow we auto-snap. Show it always so the user has
  // a fallback if auto-detection never converges.
  btnCaptureCard.disabled = capture.busy || !cvWorkerReady;
  const goodNow = !capture.busy && cvWorkerReady &&
                  scanner.lastQuality.detect >= 0.99 &&
                  scanner.lastQuality.light >= 0.25;
  btnCaptureCard.classList.toggle('ready', goodNow);
  btnCaptureCard.textContent = capture.busy
    ? '⏳ Verarbeite…'
    : `📸 Manuell auslösen`;
  scannerWrap.classList.toggle('ready', isQualityGood() && isQuadStable());
}

// ─────── On-screen debug strip ───────
let lastDebugErr = '';
function setDebug(msg) { lastDebugErr = msg; }
function updateDebug() {
  const el = document.getElementById('scanDebug');
  if (!el) return;
  const q = scanner.lastQuality;
  const g = autoSnapGates();
  const flag = (c, ch) => c ? ch : '·';
  // Compact 6-gate readout: Detect / Sharp / Light / Frame / Glare / sTability
  const gates = flag(g.detect, 'D') + flag(g.sharp, 'S') + flag(g.light, 'L') +
                flag(g.frame, 'F') + flag(g.glareOk, 'G') + flag(g.stable, 'T');
  el.textContent =
    `${capture.side}${capture.busy ? ' BUSY' : ''}  gates:${gates}\n` +
    `sharp:${(q.sharpness||0).toFixed(0)} frame:${(q.frame||0).toFixed(2)} ` +
    `light:${(q.light||0).toFixed(2)} glare:${(q.glare||0).toFixed(2)}` +
    (lastDebugErr ? `\n${lastDebugErr}` : '');
}

// ─────── High-res capture from the live stream ───────
// First try ImageCapture API (Chrome Android — gives true sensor-resolution
// stills, often higher than the video stream itself).
// Fall back to grabbing the current video frame at stream resolution (works
// everywhere including iOS Safari, capped at whatever the stream gave us).
async function captureHiRes() {
  if (capture.busy) return;
  capture.busy = true;
  setDebug('');

  try {
    // ─── 3-frame burst, sharpest wins ───
    // Grab three quick captures and pick the one with the highest Laplacian
    // variance. Modern camera shutter takes ~80–200 ms; a burst at 100 ms
    // intervals gives us enough variation to discard motion-blurred frames.
    const track = scanner.stream && scanner.stream.getVideoTracks()[0];
    const ic = (track && typeof window.ImageCapture === 'function')
      ? new window.ImageCapture(track) : null;

    async function grabOne() {
      if (ic) {
        try {
          const blob = await ic.takePhoto();
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          bmp.close && bmp.close();
          return c;
        } catch (_) { /* fall through */ }
      }
      const c = document.createElement('canvas');
      c.width = scanVideo.videoWidth;
      c.height = scanVideo.videoHeight;
      c.getContext('2d').drawImage(scanVideo, 0, 0);
      return c;
    }

    function quickSharpness(canvas) {
      // Cheap Laplacian-variance estimate on a downsampled grey copy
      const W = 240;
      const s = W / canvas.width;
      const H = Math.max(1, Math.round(canvas.height * s));
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      tmp.getContext('2d').drawImage(canvas, 0, 0, W, H);
      const d = tmp.getContext('2d').getImageData(0, 0, W, H).data;
      const g = new Float32Array(W * H);
      for (let i = 0; i < W*H; i++) g[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
      let sum = 0, sumSq = 0, n = 0;
      for (let y = 1; y < H-1; y += 2) {
        for (let x = 1; x < W-1; x += 2) {
          const c = g[y*W + x];
          const lap = 4*c - g[(y-1)*W+x] - g[(y+1)*W+x] - g[y*W+(x-1)] - g[y*W+(x+1)];
          sum += lap; sumSq += lap*lap; n++;
        }
      }
      if (n === 0) return 0;
      const m = sum / n;
      return sumSq / n - m*m;
    }

    const shots = [];
    for (let k = 0; k < 3; k++) {
      shots.push(await grabOne());
      if (k < 2) await new Promise(r => setTimeout(r, 100));
    }
    shots.sort((a, b) => quickSharpness(b) - quickSharpness(a));
    let snapCanvas = shots[0];
    setDebug(`burst: ${shots.length} shots, sharpest first`);

    // Cap at 2400px long side to keep WASM memory + rectify work bounded.
    const MAX_DIM = 2400;
    let workCanvas = snapCanvas;
    if (Math.max(snapCanvas.width, snapCanvas.height) > MAX_DIM) {
      const s = MAX_DIM / Math.max(snapCanvas.width, snapCanvas.height);
      workCanvas = document.createElement('canvas');
      workCanvas.width = Math.round(snapCanvas.width * s);
      workCanvas.height = Math.round(snapCanvas.height * s);
      workCanvas.getContext('2d').drawImage(snapCanvas, 0, 0, workCanvas.width, workCanvas.height);
    }
    setDebug(`snap: ${snapCanvas.width}×${snapCanvas.height} → work ${workCanvas.width}×${workCanvas.height}`);

    if (!cvWorkerReady) {
      await new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (cvWorkerReady) { clearInterval(iv); res(); }
          else if (Date.now() - t0 > 15000) { clearInterval(iv); rej(new Error('cv worker timeout')); }
        }, 100);
      });
    }

    // Detect the card quad in the high-res snap. We try once on the sharpest
    // shot; if it fails or returns garbage, we try the next-sharpest shot.
    let quad = null;
    for (const shot of shots) {
      const wc = shot === snapCanvas ? workCanvas : downscaleForWork(shot);
      try {
        const q = await detectInImage(wc);
        if (q && isQuadPlausible(q, wc.width, wc.height)) {
          quad = q;
          snapCanvas = shot;
          break;
        }
      } catch (_) {}
    }

    if (quad) {
      // Auto-flow: rectify straight to result, no editor.
      const finalCanvas = (snapCanvas === shots[0]) ? workCanvas : downscaleForWork(snapCanvas);
      const rectified = rectifyFromImageCorners(finalCanvas, quad, CARD_OUT_W, CARD_OUT_H);
      advanceWithRectified(rectified);
      return;
    }

    // Auto-detection failed across all shots. Fall back to the crop editor
    // so the user has a way out — but this is a recovery path, not the
    // success path.
    pauseLiveScan();
    const sideLabel = SIDE_LABEL[capture.side];
    openCropEditor(workCanvas, null, {
      sideLabel,
      onConfirm: (rectified) => advanceWithRectified(rectified),
      onBack: () => {
        capture.busy = false;
        resumeLiveScan();
        showScreen('capture');
      },
    });
  } catch (e) {
    console.warn('[hires capture]', e);
    alert('Fehler beim Verarbeiten: ' + (e.message || e));
    capture.busy = false;
  }
}

// Helper: downscale a snap to the 2400px work canvas used for detection.
function downscaleForWork(src) {
  const MAX_DIM = 2400;
  if (Math.max(src.width, src.height) <= MAX_DIM) return src;
  const s = MAX_DIM / Math.max(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s);
  c.height = Math.round(src.height * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Shared "we now have a rectified card for this side" path. Used both by the
// auto-snap success path and the crop editor's onConfirm fallback.
function advanceWithRectified(rectified) {
  if (capture.side === 'front') {
    state.frontCard = rectified;
    state.sourceImage = rectified;
    state.rectifiedCanvas = rectified;
    capture.side = 'back';
    capture.busy = false;
    resumeLiveScan();
    showScreen('capture');
    flashSideTransition();
  } else {
    state.backCard = rectified;
    finalizeCapture();
  }
}

// Plausibility check for an auto-detected quad. Rejects "near-the-whole-image"
// detections (= the algorithm probably latched onto the photo border, not the
// card) and absurd aspect ratios.
function isQuadPlausible(quad, W, H) {
  const area = quadAreaRatio(quad, W, H);
  if (area < 0.10 || area > 0.92) return false;
  const lh = dist(quad[0], quad[3]);
  const rh = dist(quad[1], quad[2]);
  const tw = dist(quad[0], quad[1]);
  const bw = dist(quad[3], quad[2]);
  const w = (tw + bw) / 2;
  const h = (lh + rh) / 2;
  const ratio = Math.min(w, h) / Math.max(w, h);
  // Pokémon card aspect ≈ 0.714; allow 0.55–0.85 after perspective.
  return ratio > 0.55 && ratio < 0.85;
}

function pauseLiveScan() {
  scanner.running = false;
  if (scanner.rafId) cancelAnimationFrame(scanner.rafId);
}
function resumeLiveScan() {
  if (!scanner.running && scanner.stream) {
    scanner.running = true;
    scanner.lastFrameTime = performance.now();
    loop();
  }
}

function flashSideTransition() {
  const el = document.getElementById('sideTransition');
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

function finalizeCapture() {
  capture.finished = true;
  capture.busy = false;
  stopScan(true);
  unlockScreen('analysis');
  showScreen('analysis');
  startAnalysis();
  setTimeout(() => {
    scanStage.style.display = 'none';
    scanWelcome.style.display = 'block';
    resetCapture();
  }, 600);
}

// ─────── Buttons ───────
document.getElementById('btnStartScan').addEventListener('click', () => {
  resetCapture();
  startScan();
});
document.getElementById('btnCancelScan').addEventListener('click', () => stopScan(false));
if (btnCaptureCard) {
  btnCaptureCard.addEventListener('click', captureHiRes);
}

// ─────── Demo card loader (synthetic card so the rest of the flow can be
// tested without a real photo). Goes through the same rectify+analysis path.
document.getElementById('loadDemo').addEventListener('click', () => {
  const c = document.createElement('canvas');
  c.width = CARD_OUT_W; c.height = CARD_OUT_H;
  const ctx = c.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, c.width, c.height);
  grd.addColorStop(0, '#f7d96e'); grd.addColorStop(0.5, '#e8be3a'); grd.addColorStop(1, '#c9a02a');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#1a3f5c'; ctx.fillRect(80, 230, 1340, 840);
  const art = ctx.createRadialGradient(750, 660, 60, 750, 660, 600);
  art.addColorStop(0, '#ffe066'); art.addColorStop(0.4, '#ff8c42');
  art.addColorStop(0.7, '#a93b6f'); art.addColorStop(1, '#1a3f5c');
  ctx.fillStyle = art; ctx.fillRect(108, 270, 1284, 780);
  ctx.fillStyle = '#000'; ctx.font = 'bold 80px Georgia'; ctx.fillText('Holofox', 150, 180);
  ctx.font = '42px Georgia'; ctx.fillStyle = '#444'; ctx.fillText('HP 120', 1150, 180);
  ctx.fillStyle = '#fff9e6'; ctx.fillRect(108, 1140, 1284, 720);
  ctx.fillStyle = '#222'; ctx.font = 'italic 48px Georgia'; ctx.fillText('Solar Flare', 150, 1260);
  ctx.font = '36px Georgia'; ctx.fillText('Once per turn, you may flip a coin.', 150, 1380);
  ctx.font = 'bold 60px Georgia'; ctx.fillText('Tail Whip · 30', 150, 1620);
  state.frontCard = c;
  state.backCard = c; // same image for demo
  state.sourceImage = c;
  state.rectifiedCanvas = c;
  unlockScreen('analysis');
  showScreen('analysis');
  startAnalysis();
});
