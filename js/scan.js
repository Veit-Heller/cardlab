// SCREEN 1: LIVE SCAN
// Camera stream → per-frame quality analysis (detect/sharpness/light/framing)
// → auto-capture when all bars are green.

const scanWelcome = document.getElementById('scanWelcome');
const scanStage = document.getElementById('scanStage');
const scanVideo = document.getElementById('scanVideo');
const scanOverlay = document.getElementById('scanOverlay');
const scanInstruction = document.getElementById('scanInstruction');
const scannerWrap = document.querySelector('.scanner-wrap');
const captureRing = document.getElementById('captureRing');
const ringFill = document.getElementById('ringFill');

const scanner = {
  stream: null,
  running: false,
  rafId: null,
  lastDetectAt: 0,
  detectInterval: 150, // ms — cheap stats (brightness/sharpness) per step
  lastCvDispatchAt: 0,
  cvInterval: 250, // ms between OpenCV detect dispatches (Worker, off main thread)
  cvBusy: false,   // true while a Worker detect is in flight (no overlap)
  cvSeq: 0,        // monotonic request id
  lastQuality: { detect: 0, sharp: 0, light: 0, frame: 0, quad: null },
  qualityHistory: [],
  readyStreak: 0,
  readyTarget: 700,
  lastFrameTime: 0,
};

// ─────── OpenCV runs in a Worker ───────
// Keeps the main thread free for camera + UI even when WASM is busy.
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
      onCvDetectResult(m.id, m.quad);
    } else if (m.type === 'detect-error') {
      scanner.cvBusy = false;
      console.warn('[cv-worker] detect error:', m.message);
    }
  };
  cvWorker.onerror = (e) => {
    console.warn('cv-worker error:', e.message || e);
    scanner.cvBusy = false;
  };
}

// ─────── Multi-view Front+Back capture ───────
// Per side we collect 5 textures at different tilt poses (center + 4 tilts).
// The same pixel coordinates align across all 5 (because each is rectified to
// the same 1500×2100 raster from its own quad). That stack feeds the WebGL
// holo renderer in the showcase, which interpolates between them based on the
// user's current viewing angle — so the card's actual hologram behaviour
// (not a CSS pseudo-effect) is reproduced digitally.

const CARD_OUT_W = 1500;
const CARD_OUT_H = 2100;
const GOOD_FRAMES_NEEDED = 5;            // good frames buffered per pose before snap
const POSE_SEQUENCE = ['center', 'left', 'right', 'up', 'down'];
const POSE_GUIDANCE = {
  center: 'gerade vor die Kamera halten',
  left:   'nach links neigen · linke Seite näher',
  right:  'nach rechts neigen · rechte Seite näher',
  up:     'oben nach hinten · obere Kante weg',
  down:   'oben nach vorn · obere Kante näher',
};
const SIDE_LABEL = { front: 'Vorderseite', back: 'Rückseite' };

const capture = {
  side: 'front',
  poseIdx: 0,           // index into POSE_SEQUENCE
  finished: false,
  goodBuffer: [],       // {sharpness, frame: Canvas, imgQuad} for current pose
  results: {
    front: { center: null, left: null, right: null, up: null, down: null },
    back:  { center: null, left: null, right: null, up: null, down: null },
  },
};

function currentPose() { return POSE_SEQUENCE[capture.poseIdx]; }

function resetCapture() {
  capture.side = 'front';
  capture.poseIdx = 0;
  capture.finished = false;
  capture.goodBuffer.length = 0;
  capture.results = {
    front: { center: null, left: null, right: null, up: null, down: null },
    back:  { center: null, left: null, right: null, up: null, down: null },
  };
}
resetCapture();

// Classify the pose by comparing edge lengths of the detected quad.
// Returns 'center' | 'left' | 'right' | 'up' | 'down' | null.
function classifyPose(quad) {
  if (!quad) return null;
  const lh = dist(quad[0], quad[3]);
  const rh = dist(quad[1], quad[2]);
  const tw = dist(quad[0], quad[1]);
  const bw = dist(quad[3], quad[2]);
  const tx = (lh - rh) / (lh + rh); // +: left edge longer → left side closer
  const ty = (bw - tw) / (bw + tw); // +: bottom edge longer → bottom closer
  const T_CENTER = 0.035;
  if (Math.abs(tx) < T_CENTER && Math.abs(ty) < T_CENTER) return 'center';
  if (Math.abs(tx) > Math.abs(ty)) return tx > 0 ? 'left' : 'right';
  return ty > 0 ? 'down' : 'up';
}

// Quality gate.
function isQualityGood() {
  const q = scanner.lastQuality;
  return q.detect >= 0.99 && q.light >= 0.30 && q.frame >= 0.50;
}

// Per rAF: if the user is in the target pose with good quality, buffer the frame.
// When enough good frames are buffered for the current pose, snap the sharpest.
function maybeBufferFrame() {
  if (capture.finished) return;
  if (!isQualityGood()) {
    if (capture.goodBuffer.length > 0) capture.goodBuffer.length = 0;
    return;
  }
  const detected = classifyPose(scanner.lastQuality.quad);
  const target = currentPose();
  if (detected !== target) {
    // Wrong pose — don't buffer, but don't clear either; transient mismatches
    // during rotation are normal. Buffer naturally drains via the quality gate.
    return;
  }
  try {
    const MAX_DIM = 1920;
    const vw = scanVideo.videoWidth, vh = scanVideo.videoHeight;
    const s = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const cw = Math.round(vw * s), ch = Math.round(vh * s);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    c.getContext('2d').drawImage(scanVideo, 0, 0, cw, ch);
    const qs = scanner.lastQuality.quadScale * s;
    const imgQuad = scanner.lastQuality.quad.map(p => ({ x: p.x * qs, y: p.y * qs }));
    capture.goodBuffer.push({
      sharpness: scanner.lastQuality.sharpness,
      frame: c,
      imgQuad,
    });
    if (capture.goodBuffer.length >= GOOD_FRAMES_NEEDED) {
      finalizePose();
    }
  } catch (e) {
    setDebug('buffer-err: ' + (e.message || e));
    console.warn('[buffer]', e);
  }
}

// Snap sharpest buffered frame for the current pose, advance to the next pose
// (or to the back side, or to analysis).
function finalizePose() {
  capture.goodBuffer.sort((a, b) => b.sharpness - a.sharpness);
  const best = capture.goodBuffer[0];
  const rectified = rectifyFromImageCorners(best.frame, best.imgQuad, CARD_OUT_W, CARD_OUT_H);
  capture.results[capture.side][currentPose()] = rectified;
  capture.goodBuffer.length = 0;

  capture.poseIdx++;
  if (capture.poseIdx >= POSE_SEQUENCE.length) {
    finalizeSide();
  }
}

function finalizeSide() {
  if (capture.side === 'front') {
    state.frontFrames = capture.results.front;
    state.frontCard = state.frontFrames.center; // back-compat for analysis + showcase fallback
    capture.side = 'back';
    capture.poseIdx = 0;
    flashSideTransition();
  } else {
    state.backFrames = capture.results.back;
    state.backCard = state.backFrames.center;
    finalizeAll();
  }
}

function finalizeAll() {
  if (capture.finished) return;
  capture.finished = true;
  state.sourceImage = state.frontCard;
  state.rectifiedCanvas = state.frontCard;
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

// Short on-screen overlay between front and back capture so the user has
// a clear cue to flip the card.
function flashSideTransition() {
  const el = document.getElementById('sideTransition');
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

// ─────── On-screen debug strip ───────
let lastDebugErr = '';
function setDebug(msg) { lastDebugErr = msg; }
function updateDebug() {
  const el = document.getElementById('scanDebug');
  if (!el) return;
  const q = scanner.lastQuality;
  const detected = q.quad ? classifyPose(q.quad) : '–';
  el.textContent =
    `${capture.side} · pose:${currentPose()} (see:${detected}) ` +
    `buf:${capture.goodBuffer.length}/${GOOD_FRAMES_NEEDED}\n` +
    `sharp:${(q.sharpness||0).toFixed(0)} frame:${(q.frame||0).toFixed(2)} ` +
    `light:${(q.light||0).toFixed(2)} detect:${q.detect}` +
    (lastDebugErr ? `\n${lastDebugErr}` : '');
}

async function startScan() {
  scanWelcome.style.display = 'none';
  scanStage.style.display = 'block';

  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (err) {
    alert('Camera access denied or unavailable.\n\n' + err.message +
          '\n\nMake sure you are on https:// or localhost.');
    stopScan(false); // reset UI back to welcome on permission/error
    return;
  }
  // OpenCV lives in a Worker — its WASM compile + every detect runs off the
  // main thread, so the camera stays responsive even on phones.
  setupCvWorker();
  scanVideo.srcObject = scanner.stream;
  await scanVideo.play().catch(() => {});

  // Wait for video metadata so we know the real frame size
  if (!scanVideo.videoWidth) {
    await new Promise(r => scanVideo.addEventListener('loadedmetadata', r, { once: true }));
  }

  // Size overlay canvas to match the *rendered* video size
  resizeOverlay();
  window.addEventListener('resize', resizeOverlay);

  scanner.running = true;
  scanner.lastFrameTime = performance.now();
  scanner.readyStreak = 0;
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

function loop() {
  if (!scanner.running) return;
  try {
    const now = performance.now();
    const dt = now - scanner.lastFrameTime;
    scanner.lastFrameTime = now;

    if (now - scanner.lastDetectAt > scanner.detectInterval) {
      scanner.lastDetectAt = now;
      runDetectionStep();
    }

    drawScanOverlay();
    updateAutoCapture(dt);
    updateDebug();
  } catch (e) {
    setDebug('loop-err: ' + (e.message || e));
    console.error('[scan loop]', e);
  }
  // Always re-arm the next frame, even if this one threw, so a transient
  // error doesn't kill the entire scan UI.
  scanner.rafId = requestAnimationFrame(loop);
}

// ─────── Detection step: grab frame, analyze quality ───────
const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

function runDetectionStep() {
  if (!scanVideo.videoWidth) return;

  // Downsample the current video frame for fast analysis
  const TARGET = 480;
  const vw = scanVideo.videoWidth;
  const vh = scanVideo.videoHeight;
  const s = Math.min(1, TARGET / Math.max(vw, vh));
  const dw = Math.round(vw * s);
  const dh = Math.round(vh * s);
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  detectCtx.drawImage(scanVideo, 0, 0, dw, dh);
  const imgData = detectCtx.getImageData(0, 0, dw, dh);

  // 1. Brightness (mean) & contrast — cheap, sync on main thread
  const { mean, stddev } = brightnessStats(imgData);

  // 2. Sharpness via Laplacian variance — cheap, sync
  const sharpness = laplacianVariance(imgData);

  // 3. Card detection runs in the Worker. Reuse last known quad until the
  //    next worker reply arrives.
  const quad = scanner.lastQuality.quad;
  const now = performance.now();
  if (cvWorkerReady && !scanner.cvBusy && now - scanner.lastCvDispatchAt > scanner.cvInterval) {
    scanner.lastCvDispatchAt = now;
    scanner.cvBusy = true;
    scanner.cvSeq++;
    // Transfer the underlying buffer so we don't pay a copy
    cvWorker.postMessage(
      { type: 'detect', id: scanner.cvSeq, rgba: imgData.data, w: dw, h: dh },
      [imgData.data.buffer]
    );
  }

  // 4. Framing score (uses whatever quad we currently have)
  let frameScore = 0;
  let coverage = 0;
  if (quad) {
    coverage = quadAreaRatio(quad, dw, dh);
    frameScore = framingScore(quad, dw, dh);
  }

  const sharpNorm = clamp(sharpness / 600, 0, 1);
  const lightNorm = clamp((mean - 30) / 140, 0, 1) * clamp(stddev / 50, 0, 1);
  const detectNorm = quad ? 1 : 0;
  const frameNorm = frameScore;

  scanner.lastQuality = {
    detect: detectNorm,
    sharp: sharpNorm,
    light: lightNorm,
    frame: frameNorm,
    quad,
    quadScale: 1 / s, // map detect-canvas coords back to video coords
    coverage,
    mean,
    stddev,
    sharpness,
  };

  updateHUD();
  updateInstruction();
}

// Called when the worker sends back a fresh quad detection.
function onCvDetectResult(_id, quad) {
  // Update only the quad — keep the most recent brightness/sharpness stats.
  scanner.lastQuality.quad = quad;
  scanner.lastQuality.detect = quad ? 1 : 0;
  if (quad) {
    const dCanvas = detectCanvas;
    scanner.lastQuality.coverage = quadAreaRatio(quad, dCanvas.width, dCanvas.height);
    scanner.lastQuality.frame = framingScore(quad, dCanvas.width, dCanvas.height);
  } else {
    scanner.lastQuality.coverage = 0;
    scanner.lastQuality.frame = 0;
  }
  updateHUD();
  updateInstruction();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function brightnessStats(imgData) {
  const d = imgData.data;
  let sum = 0, sumSq = 0, n = 0;
  // Sample every 8th pixel for speed
  for (let i = 0; i < d.length; i += 32) {
    const b = (d[i] + d[i+1] + d[i+2]) / 3;
    sum += b; sumSq += b*b; n++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean*mean;
  return { mean, stddev: Math.sqrt(Math.max(0, variance)) };
}

function laplacianVariance(imgData) {
  // Compute Laplacian on grayscale, return variance
  const W = imgData.width, H = imgData.height;
  const d = imgData.data;
  const gray = new Float32Array(W*H);
  for (let i = 0; i < W*H; i++) {
    gray[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
  }
  // 3x3 Laplacian kernel: center 4, neighbors -1 (or center -4, neighbors 1)
  let sum = 0, sumSq = 0, n = 0;
  // Sample every 3rd pixel for speed
  for (let y = 1; y < H-1; y += 3) {
    for (let x = 1; x < W-1; x += 3) {
      const c = gray[y*W + x];
      const t = gray[(y-1)*W + x];
      const b = gray[(y+1)*W + x];
      const l = gray[y*W + (x-1)];
      const r = gray[y*W + (x+1)];
      const lap = 4*c - t - b - l - r;
      sum += lap; sumSq += lap*lap; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean*mean;
}

// Detect card quad in the current frame using OpenCV
function detectCardQuadInFrame(canvas) {
  const cv = window.cv;
  let src, gray, blurred, edges, kernel, hierarchy, contours;
  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 40, 120);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = canvas.width * canvas.height;
    let bestQuad = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * 0.08 || area > imgArea * 0.95) { cnt.delete(); continue; }
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, peri * 0.025, true);
      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.data32S[r*2], y: approx.data32S[r*2+1] });
        }
        const ordered = orderQuadCorners(pts);
        const w = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
        const h = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
        const ratio = Math.min(w, h) / Math.max(w, h);
        if (ratio > 0.5 && ratio < 0.92) {
          bestArea = area;
          bestQuad = ordered;
        }
      }
      approx.delete();
      cnt.delete();
    }
    return bestQuad;
  } catch (e) {
    return null;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (kernel) kernel.delete();
    if (hierarchy) hierarchy.delete();
    if (contours) contours.delete();
  }
}

function quadAreaRatio(quad, W, H) {
  // Shoelace formula
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i], q = quad[(i+1) % 4];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2 / (W * H);
}

function framingScore(quad, W, H) {
  // Guide rect: centered, 68% of width of the SCANNER (which has 3:4 aspect ratio
  // matching our scanner-wrap). But our detect canvas has the video's aspect ratio.
  // For simplicity, treat the framing target as: card centered, takes 50–80% of the area,
  // not strongly tilted.
  const area = quadAreaRatio(quad, W, H);
  // Sweet spot: 0.45–0.75 area coverage
  let coverageScore;
  if (area < 0.25) coverageScore = area / 0.25 * 0.5;
  else if (area < 0.45) coverageScore = 0.5 + (area - 0.25) / 0.20 * 0.5;
  else if (area < 0.75) coverageScore = 1.0;
  else if (area < 0.95) coverageScore = 1.0 - (area - 0.75) / 0.20 * 0.4;
  else coverageScore = 0.6 - (area - 0.95) / 0.05 * 0.6;
  coverageScore = clamp(coverageScore, 0, 1);

  // Center alignment
  const cx = quad.reduce((s,p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s,p) => s + p.y, 0) / 4;
  const dxNorm = Math.abs(cx - W/2) / (W/2);
  const dyNorm = Math.abs(cy - H/2) / (H/2);
  const centerScore = clamp(1 - (dxNorm + dyNorm), 0, 1);

  // Tilt penalty: how rectangular is the quad?
  const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const ratio = Math.min(w, h) / Math.max(w, h);
  // Pokemon card aspect = 5/7 ≈ 0.714. If we see e.g. 0.5, it's tilted.
  const ratioScore = clamp(1 - Math.abs(ratio - 0.714) * 3, 0, 1);

  return coverageScore * 0.5 + centerScore * 0.3 + ratioScore * 0.2;
}

// ─────── Overlay rendering ───────
function drawScanOverlay() {
  const ctx = scanOverlay.getContext('2d');
  ctx.clearRect(0, 0, scanOverlay.width, scanOverlay.height);

  const q = scanner.lastQuality.quad;
  if (!q) return;

  // Convert quad from detect-canvas coords → overlay coords.
  // detect canvas was sized from video, video is rendered with object-fit:cover.
  // We need the video's *visible* region scale.
  const vw = scanVideo.videoWidth, vh = scanVideo.videoHeight;
  const ow = scanOverlay.width, oh = scanOverlay.height;
  // object-fit: cover → video fills overlay, but parts may be cropped
  const videoAspect = vw / vh;
  const overlayAspect = ow / oh;
  let scale, offX, offY;
  if (videoAspect > overlayAspect) {
    // video wider than overlay: crops left/right
    scale = oh / vh;
    offX = (ow - vw * scale) / 2;
    offY = 0;
  } else {
    // video taller than overlay: crops top/bottom
    scale = ow / vw;
    offX = 0;
    offY = (oh - vh * scale) / 2;
  }
  // Detect canvas was scaled from video by 1/scanner.lastQuality.quadScale
  // Actually quadScale = 1/s, so multiply: video_x = detect_x * quadScale
  const qs = scanner.lastQuality.quadScale;

  ctx.beginPath();
  q.forEach((p, i) => {
    const vx = p.x * qs;
    const vy = p.y * qs;
    const ox = vx * scale + offX;
    const oy = vy * scale + offY;
    if (i === 0) ctx.moveTo(ox, oy);
    else ctx.lineTo(ox, oy);
  });
  ctx.closePath();

  const allGood = isQualityGood();
  ctx.strokeStyle = allGood ? 'rgba(95,220,140,0.95)' : 'rgba(106,255,227,0.85)';
  ctx.lineWidth = 3;
  ctx.shadowColor = allGood ? 'rgba(95,220,140,0.6)' : 'rgba(106,255,227,0.5)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Draw corner accents
  q.forEach((p, i) => {
    const vx = p.x * qs;
    const vy = p.y * qs;
    const ox = vx * scale + offX;
    const oy = vy * scale + offY;
    ctx.fillStyle = allGood ? '#5fdc8c' : '#6affe3';
    ctx.beginPath();
    ctx.arc(ox, oy, 5, 0, Math.PI*2);
    ctx.fill();
  });
}

// ─────── HUD & instruction updates ───────
function updateHUD() {
  scannerWrap.classList.toggle('ready', isQualityGood());
  updateCaptureProgressUI();
}

// Pose dots now indicate per-pose capture progress for the current side:
// dot.captured = pose already snapped, dot.current = pose we're collecting now.
function updateCaptureProgressUI() {
  const completed = capture.results[capture.side];
  const target = currentPose();
  document.querySelectorAll('.pose-dot').forEach(dot => {
    const p = dot.dataset.pose;
    dot.classList.toggle('captured', !!completed[p]);
    dot.classList.toggle('current', p === target);
  });
  const badge = document.getElementById('poseCount');
  if (badge) {
    badge.textContent =
      `${SIDE_LABEL[capture.side]} · Pose ${capture.poseIdx + 1}/${POSE_SEQUENCE.length}`;
  }
}

function updateInstruction() {
  const q = scanner.lastQuality;
  let msg, good = false;
  const sideLabel = SIDE_LABEL[capture.side];
  const target = currentPose();

  if (!cvWorkerReady) {
    msg = 'Initialisiere Detektor…';
  } else if (q.detect < 0.99) {
    msg = `${sideLabel} vor die Kamera halten`;
  } else if (q.light < 0.30) {
    msg = 'Mehr Licht bitte';
  } else if (q.frame < 0.50) {
    if (q.coverage < 0.25) msg = 'Näher ran';
    else if (q.coverage > 0.85) msg = 'Etwas weiter weg';
    else msg = 'Karte mittig halten';
  } else {
    const detected = classifyPose(q.quad);
    if (detected === target) {
      msg = `${sideLabel} · ${POSE_GUIDANCE[target]} · ruhig halten`;
      good = true;
    } else {
      msg = `Jetzt ${POSE_GUIDANCE[target]}`;
    }
  }
  scanInstruction.textContent = msg;
  scanInstruction.classList.toggle('good', good);
}

// Per-frame capture trigger: buffer good frames, snap sharpest of N in a row.
function updateAutoCapture(_dt) {
  if (capture.finished) return;
  const filled = capture.goodBuffer.length;
  captureRing.classList.toggle('active', filled > 0);
  const pct = filled / GOOD_FRAMES_NEEDED;
  ringFill.style.strokeDashoffset = (289 * (1 - pct)).toFixed(1);
  maybeBufferFrame();
}

// Legacy single-shot path — only reached now via "Load demo card" through
// captureFrameNow → crop screen. Not used by the live scanner anymore.
function captureFrameNow() {
  // Snap full-resolution frame to an Image
  const c = document.createElement('canvas');
  c.width = scanVideo.videoWidth;
  c.height = scanVideo.videoHeight;
  c.getContext('2d').drawImage(scanVideo, 0, 0);

  const img = new Image();
  img.onload = () => {
    state.sourceImage = img;
    stopScan(true);
    scanWelcome.style.display = 'none'; // stay hidden
    initCropScreen();
    unlockScreen('crop');
    showScreen('crop');
    // Restore welcome for next time
    setTimeout(() => {
      scanStage.style.display = 'none';
      scanWelcome.style.display = 'block';
    }, 500);
  };
  img.src = c.toDataURL('image/jpeg', 0.92);
}

// Wire up buttons
document.getElementById('btnStartScan').addEventListener('click', () => {
  resetCapture();
  startScan();
});
document.getElementById('btnCancelScan').addEventListener('click', () => stopScan(false));

function loadImage(file) {
  // Kept for backwards compat (e.g. demo card path), but no file-picker UI anymore
  if (!file.type || !file.type.startsWith('image/')) {
    alert('Please pick an image file.');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      state.sourceImage = img;
      initCropScreen();
      unlockScreen('crop');
      showScreen('crop');
    };
    img.onerror = () => alert('Could not load this image.');
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Demo card loader — generates a synthetic card so we have something
// even without any uploaded image. We draw a stylized "demo" card on canvas.
document.getElementById('loadDemo').addEventListener('click', () => {
  const c = document.createElement('canvas');
  c.width = 500;
  c.height = 700;
  const ctx = c.getContext('2d');

  // Yellow card border (classic Pokémon)
  const grd = ctx.createLinearGradient(0, 0, 500, 700);
  grd.addColorStop(0, '#f7d96e');
  grd.addColorStop(0.5, '#e8be3a');
  grd.addColorStop(1, '#c9a02a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 500, 700);

  // Inner artwork frame
  ctx.fillStyle = '#1a3f5c';
  ctx.fillRect(28, 80, 444, 280);

  // "Art" - abstract
  const artGrd = ctx.createRadialGradient(250, 220, 20, 250, 220, 200);
  artGrd.addColorStop(0, '#ffe066');
  artGrd.addColorStop(0.4, '#ff8c42');
  artGrd.addColorStop(0.7, '#a93b6f');
  artGrd.addColorStop(1, '#1a3f5c');
  ctx.fillStyle = artGrd;
  ctx.fillRect(36, 90, 428, 260);

  // Sparkles
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + Math.random()*0.6) + ')';
    ctx.beginPath();
    ctx.arc(36 + Math.random()*428, 90 + Math.random()*260, Math.random()*2, 0, Math.PI*2);
    ctx.fill();
  }

  // Name banner
  ctx.fillStyle = '#000';
  ctx.font = 'bold 28px Georgia';
  ctx.fillText('Holofox', 50, 60);
  ctx.font = '14px Georgia';
  ctx.fillStyle = '#444';
  ctx.fillText('HP 120', 380, 60);

  // Text box
  ctx.fillStyle = '#fff9e6';
  ctx.fillRect(36, 380, 428, 240);
  ctx.fillStyle = '#222';
  ctx.font = 'italic 16px Georgia';
  ctx.fillText('Solar Flare', 50, 420);
  ctx.font = '12px Georgia';
  ctx.fillText('Once per turn, you may flip a coin.', 50, 460);
  ctx.fillText('If heads, your opponent\'s active', 50, 478);
  ctx.fillText('Pokémon is now Burned.', 50, 496);

  ctx.font = 'bold 20px Georgia';
  ctx.fillText('Tail Whip · 30', 50, 540);
  ctx.font = '12px Georgia';
  ctx.fillText('Flip a coin. If tails, this attack', 50, 568);
  ctx.fillText('does nothing.', 50, 586);

  // Bottom info
  ctx.fillStyle = '#000';
  ctx.font = '10px Georgia';
  ctx.fillText('© 2026 CardLab · 042/151 · ★', 36, 670);

  // Convert to image
  const img = new Image();
  img.onload = () => {
    state.sourceImage = img;
    initCropScreen();
    unlockScreen('crop');
    showScreen('crop');
  };
  img.src = c.toDataURL('image/png');
});
