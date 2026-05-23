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
  cvInterval: 250,
  cvBusy: false,
  cvSeq: 0,
  lastQuality: { detect: 0, sharp: 0, light: 0, frame: 0, quad: null, quadScale: 1 },
};

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

// ─────── Live preview loop ───────
// Detection here is *preview-only* — it shows the user where the card is so
// they know when to tap "Foto machen". The high-res snap goes through a
// separate file-input pipeline below.
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
  } catch (e) {
    setDebug('loop-err: ' + (e.message || e));
    console.error('[scan loop]', e);
  }
  scanner.rafId = requestAnimationFrame(loop);
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
  } else {
    scanner.lastQuality.coverage = 0;
    scanner.lastQuality.frame = 0;
  }
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
  const good = isQualityGood();

  ctx.beginPath();
  q.forEach((p, i) => {
    const ox = p.x * qs * scale + offX;
    const oy = p.y * qs * scale + offY;
    if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
  });
  ctx.closePath();
  ctx.strokeStyle = good ? 'rgba(95,220,140,0.95)' : 'rgba(106,255,227,0.85)';
  ctx.lineWidth = 3;
  ctx.shadowColor = good ? 'rgba(95,220,140,0.6)' : 'rgba(106,255,227,0.5)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  q.forEach(p => {
    const ox = p.x * qs * scale + offX;
    const oy = p.y * qs * scale + offY;
    ctx.fillStyle = good ? '#5fdc8c' : '#6affe3';
    ctx.beginPath();
    ctx.arc(ox, oy, 5, 0, Math.PI*2);
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
    scanInstruction.textContent = 'Foto wird verarbeitet…';
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
  } else if (q.light < 0.30) {
    msg = 'Mehr Licht bitte';
  } else if (q.frame < 0.50) {
    if (q.coverage < 0.25) msg = 'Näher ran';
    else if (q.coverage > 0.85) msg = 'Etwas weiter weg';
    else msg = 'Karte mittig halten';
  } else {
    msg = `${sideLabel} bereit · Tap auf Foto-Button`;
    good = true;
  }
  scanInstruction.textContent = msg;
  scanInstruction.classList.toggle('good', good);
}

function updateCaptureButton() {
  if (!btnCaptureCard) return;
  const ready = isQualityGood() && !capture.busy;
  btnCaptureCard.disabled = !ready;
  btnCaptureCard.classList.toggle('ready', ready);
  btnCaptureCard.textContent = capture.busy
    ? '⏳ Verarbeite…'
    : `📸 ${SIDE_LABEL[capture.side]} fotografieren`;
  scannerWrap.classList.toggle('ready', ready);
}

// ─────── On-screen debug strip ───────
let lastDebugErr = '';
function setDebug(msg) { lastDebugErr = msg; }
function updateDebug() {
  const el = document.getElementById('scanDebug');
  if (!el) return;
  const q = scanner.lastQuality;
  el.textContent =
    `side:${capture.side}  ${capture.busy ? 'busy' : 'ready=' + isQualityGood()}\n` +
    `sharp:${(q.sharpness||0).toFixed(0)} frame:${(q.frame||0).toFixed(2)} ` +
    `light:${(q.light||0).toFixed(2)} detect:${q.detect}` +
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
    let snapCanvas = null;

    // 1) ImageCapture API — gives the highest still-photo resolution the
    //    camera supports, separate from the (smaller) video preview stream.
    const track = scanner.stream && scanner.stream.getVideoTracks()[0];
    if (track && typeof window.ImageCapture === 'function') {
      try {
        const ic = new window.ImageCapture(track);
        const photoBlob = await ic.takePhoto();
        const bitmap = await createImageBitmap(photoBlob);
        snapCanvas = document.createElement('canvas');
        snapCanvas.width = bitmap.width;
        snapCanvas.height = bitmap.height;
        snapCanvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close && bitmap.close();
      } catch (e) {
        console.warn('[capture] ImageCapture failed, falling back to video frame:', e.message || e);
        snapCanvas = null;
      }
    }

    // 2) Fallback: grab current video frame at stream resolution.
    if (!snapCanvas) {
      snapCanvas = document.createElement('canvas');
      snapCanvas.width = scanVideo.videoWidth;
      snapCanvas.height = scanVideo.videoHeight;
      snapCanvas.getContext('2d').drawImage(scanVideo, 0, 0);
    }

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

    // Detect the card quad. If detection fails or returns something implausible,
    // we still open the editor — the user can drag corners manually.
    let quad = null;
    try {
      quad = await detectInImage(workCanvas);
    } catch (e) {
      console.warn('[detect on snap]', e.message);
    }
    if (quad && !isQuadPlausible(quad, workCanvas.width, workCanvas.height)) {
      // Auto-detection returned something but it's almost-the-whole-image or
      // an absurd aspect ratio. Drop it; user adjusts from defaults.
      quad = null;
    }

    // Pause the live scanner while the user is in the crop editor — otherwise
    // the camera keeps running in the background and burns battery.
    pauseLiveScan();

    const sideLabel = SIDE_LABEL[capture.side];
    openCropEditor(workCanvas, quad, {
      sideLabel,
      onConfirm: (rectified) => {
        if (capture.side === 'front') {
          state.frontCard = rectified;
          state.sourceImage = rectified;
          state.rectifiedCanvas = rectified;
          capture.side = 'back';
          capture.busy = false;
          // Back to scanner for the back side
          resumeLiveScan();
          showScreen('capture');
          flashSideTransition();
        } else {
          state.backCard = rectified;
          finalizeCapture();
        }
      },
      onBack: () => {
        // Cancel this snap, return to scanner for another try
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
