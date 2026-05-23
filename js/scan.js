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

// ─────── Multi-angle capture: pose detection + state machine ───────
// We classify the current card pose from the projected quad and require the
// user to hold the card in each of 5 poses (center + 4 tilts). The sharpest
// frame per pose is kept; once all 5 are collected, the center frame is
// rectified and handed to the analysis screen.
const POSES = ['center', 'left', 'right', 'up', 'down'];
const POSE_HINT = {
  center: 'Halt die Karte gerade vor die Kamera',
  left:   'Jetzt linke Seite zur Kamera neigen',
  right:  'Jetzt rechte Seite zur Kamera neigen',
  up:     'Jetzt obere Kante zur Kamera neigen',
  down:   'Jetzt untere Kante zur Kamera neigen',
};

const captureState = {
  perPose: {}, // pose → { sharpness, frame: Canvas, imgQuad: [{x,y}*4] }
  finished: false,
};
function resetCaptureState() {
  captureState.perPose = {};
  captureState.finished = false;
  POSES.forEach(p => { captureState.perPose[p] = null; });
}
resetCaptureState();

// Classify the pose by comparing edge lengths of the detected quad.
// Returns 'center' | 'left' | 'right' | 'up' | 'down' | null.
function classifyPose(quad) {
  if (!quad) return null;
  const lh = dist(quad[0], quad[3]); // TL-BL  left edge in projection
  const rh = dist(quad[1], quad[2]); // TR-BR  right edge
  const tw = dist(quad[0], quad[1]); // TL-TR  top edge
  const bw = dist(quad[3], quad[2]); // BL-BR  bottom edge
  // tx > 0 → left edge appears longer than right → card tilted so left side is closer to camera
  // ty > 0 → bottom edge appears longer than top → card tilted so bottom is closer to camera
  const tx = (lh - rh) / (lh + rh);
  const ty = (bw - tw) / (bw + tw);
  const T = 0.04; // ~5° tilt registers; was 0.07 (~10°) which felt unreachable
  if (Math.abs(tx) < T && Math.abs(ty) < T) return 'center';
  if (Math.abs(tx) > Math.abs(ty)) return tx > 0 ? 'left' : 'right';
  return ty > 0 ? 'down' : 'up';
}

// Are quad + light + framing all "good enough" to consider capturing?
// Sharpness is NOT a gate — it would block forever on phones whose normal
// handheld blur sits below the threshold. Instead we use it as a tiebreaker
// inside maybeRecordPoseFrame(): the sharpest frame seen for each pose wins.
function isQualityGood() {
  const q = scanner.lastQuality;
  return q.detect >= 0.99 && q.light >= 0.35 && q.frame >= 0.55;
}

// If the current frame is good and improves over what we have for this pose, store it.
// Wrapped in try/catch — any exception here used to kill the rAF loop entirely,
// freezing the whole scan UI.
function maybeRecordPoseFrame() {
  if (captureState.finished) return;
  if (!isQualityGood()) return;
  try {
    const pose = classifyPose(scanner.lastQuality.quad);
    if (!pose) return;
    const slot = captureState.perPose[pose];
    const sharp = scanner.lastQuality.sharpness;
    if (slot && slot.sharpness >= sharp) return; // not better
    // Cap captured frame to ~1280px on the long side so 5 of them don't blow
    // through phone memory (full-HD × 5 = ~40MB of RGBA pixels).
    const MAX_DIM = 1280;
    const vw = scanVideo.videoWidth, vh = scanVideo.videoHeight;
    const s = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const cw = Math.round(vw * s), ch = Math.round(vh * s);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    c.getContext('2d').drawImage(scanVideo, 0, 0, cw, ch);
    // Quad → capture-canvas coords: detect → video (× quadScale) → capture (× s)
    const qs = scanner.lastQuality.quadScale * s;
    const imgQuad = scanner.lastQuality.quad.map(p => ({ x: p.x * qs, y: p.y * qs }));
    captureState.perPose[pose] = { sharpness: sharp, frame: c, imgQuad };
    updatePoseUI();
    if (POSES.every(p => captureState.perPose[p])) {
      finalizeMultiAngle();
    }
  } catch (e) {
    setDebug('capture-err: ' + (e.message || e));
    console.warn('[capture]', e);
  }
}

// ─────── On-screen debug strip ───────
// Small overlay so the user (and we) can see what the scanner is doing
// when something silently fails.
let lastDebugErr = '';
function setDebug(msg) {
  lastDebugErr = msg;
}
function updateDebug() {
  const el = document.getElementById('scanDebug');
  if (!el) return;
  const q = scanner.lastQuality;
  const pose = q.quad ? classifyPose(q.quad) : '–';
  el.textContent =
    `pose:${pose}  sharp:${(q.sharpness||0).toFixed(0)}  ` +
    `frame:${(q.frame||0).toFixed(2)}  detect:${q.detect}` +
    (lastDebugErr ? `\n${lastDebugErr}` : '');
}

function finalizeMultiAngle() {
  if (captureState.finished) return;
  captureState.finished = true;
  // Use the center frame for analysis (least perspective distortion to rectify).
  const center = captureState.perPose.center;
  state.sourceImage = center.frame;
  // Rectify directly from image-space quad — no manual crop step.
  state.rectifiedCanvas = rectifyFromImageCorners(center.frame, center.imgQuad);
  stopScan(true);
  unlockScreen('analysis');
  showScreen('analysis');
  startAnalysis();
  // After a moment, restore welcome UI for the next session
  setTimeout(() => {
    scanStage.style.display = 'none';
    scanWelcome.style.display = 'block';
    resetCaptureState();
    updatePoseUI();
  }, 600);
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

  const allGood = isAllGood();
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
// The HUD is now a row of 5 pose dots + a dynamic guidance message.
// We update them in updatePoseUI() called from runDetectionStep and onCvDetectResult.
function updateHUD() {
  scannerWrap.classList.toggle('ready', isQualityGood());
  updatePoseUI();
}

function updatePoseUI() {
  const currentPose = classifyPose(scanner.lastQuality.quad);
  POSES.forEach(p => {
    const dot = document.querySelector(`.pose-dot[data-pose="${p}"]`);
    if (!dot) return;
    dot.classList.toggle('captured', !!captureState.perPose[p]);
    // Highlight which pose the algorithm currently thinks the user is holding —
    // so they can see "I'm tilting but it's still reading 'center', tilt more".
    dot.classList.toggle('current', p === currentPose);
  });
  const badge = document.getElementById('poseCount');
  if (badge) {
    const n = POSES.filter(p => captureState.perPose[p]).length;
    badge.textContent = `${n}/${POSES.length}`;
  }
}

function updateInstruction() {
  const q = scanner.lastQuality;
  let msg, good = false;

  if (!cvWorkerReady) {
    msg = 'Initialisiere Detektor…';
  } else if (q.detect < 0.99) {
    msg = 'Halt eine Karte ins Bild';
  } else if (q.light < 0.35) {
    msg = 'Mehr Licht bitte';
  } else if (q.frame < 0.55) {
    if (q.coverage < 0.25) msg = 'Näher ran';
    else if (q.coverage > 0.85) msg = 'Etwas weiter weg';
    else msg = 'Karte mittig halten';
  } else {
    // Quality is good — guide toward the next missing pose
    const currentPose = classifyPose(q.quad);
    const missing = POSES.find(p => !captureState.perPose[p]);
    if (!missing) {
      msg = 'Alle Posen erfasst — Analyse läuft…';
      good = true;
    } else if (currentPose === missing) {
      msg = `Genau so halten · Pose ${missing} wird erfasst`;
      good = true;
    } else {
      msg = POSE_HINT[missing];
    }
  }
  scanInstruction.textContent = msg;
  scanInstruction.classList.toggle('good', good);
}

// ─────── Per-frame capture trigger ───────
// On every detection step, if quality is good and the current pose isn't yet
// captured (or this frame is sharper than what we have), store it. No 700ms
// hold-still timer — sharpness is the gate.
function updateAutoCapture(_dt) {
  if (captureState.finished) return;
  // Light pose-progress ring around the scanner: how many of 5 are done
  const done = POSES.filter(p => captureState.perPose[p]).length;
  captureRing.classList.toggle('active', done > 0);
  const pct = done / POSES.length;
  ringFill.style.strokeDashoffset = (289 * (1 - pct)).toFixed(1);
  maybeRecordPoseFrame();
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
  resetCaptureState();
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
