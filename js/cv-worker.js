// OpenCV runs here in a Web Worker so its WASM compile and per-frame
// edge/contour pipeline don't block the main thread. We accept ImageData
// (RGBA bytes + dimensions) and return either a detected quad or null.
//
// The detector runs multiple parameter passes (adaptive Canny based on the
// image's own brightness, plus a couple of fixed fallbacks for unusual
// lighting) and accepts contours of 4–6 vertices via convex-hull cleanup —
// so a finger on a corner doesn't kill the entire frame.

self.Module = {
  onRuntimeInitialized() {
    self.postMessage({ type: 'ready' });
  },
};

// importScripts is synchronous — the worker won't post 'ready' until
// the WASM is fully compiled and initialized.
importScripts('https://docs.opencv.org/4.10.0/opencv.js');

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function orderQuadCorners(pts) {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of pts) {
    const s = p.x + p.y, d = p.y - p.x;
    if (s < minSum) { minSum = s; tl = p; }
    if (s > maxSum) { maxSum = s; br = p; }
    if (d < minDiff) { minDiff = d; tr = p; }
    if (d > maxDiff) { maxDiff = d; bl = p; }
  }
  return [tl, tr, br, bl];
}

// One detection attempt with a specific parameter set. Returns a quad
// {tl,tr,br,bl} or null. Also tries a convex-hull cleanup so contours
// with a finger on a corner (5–6 vertices) can still snap to 4.
function detectQuadOnce(gray, w, h, opts) {
  const cv = self.cv;
  const {
    cannyLow, cannyHigh,
    minAreaRatio = 0.05,
    maxAreaRatio = 0.97,
    approxEpsilon = 0.04,
    minAspectRatio = 0.4,
    maxAspectRatio = 0.95,
    dilateIters = 1,
  } = opts;

  let blurred, edges, kernel, hierarchy, contours;
  try {
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, cannyLow, cannyHigh);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    for (let k = 0; k < dilateIters; k++) cv.dilate(edges, edges, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = w * h;
    let bestQuad = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * minAreaRatio || area > imgArea * maxAreaRatio) {
        cnt.delete();
        continue;
      }
      const peri = cv.arcLength(cnt, true);

      // Approximate to a polygon. Try the literal contour first; if it has
      // more than 4 vertices, fall back to its convex hull (handles a finger
      // pinching off a corner).
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, peri * approxEpsilon, true);

      let candidateApprox = null;
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        candidateApprox = approx;
      } else if (approx.rows >= 4 && approx.rows <= 8) {
        // Try convex hull → re-approx with looser epsilon
        const hull = new cv.Mat();
        cv.convexHull(cnt, hull, false, true);
        const hullApprox = new cv.Mat();
        cv.approxPolyDP(hull, hullApprox, peri * 0.06, true);
        if (hullApprox.rows === 4 && cv.isContourConvex(hullApprox)) {
          candidateApprox = hullApprox;
          approx.delete();
        } else {
          hullApprox.delete();
          approx.delete();
        }
        hull.delete();
      } else {
        approx.delete();
      }

      if (candidateApprox && area > bestArea) {
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: candidateApprox.data32S[r * 2], y: candidateApprox.data32S[r * 2 + 1] });
        }
        const ordered = orderQuadCorners(pts);
        const wq = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
        const hq = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
        const ratio = Math.min(wq, hq) / Math.max(wq, hq);
        if (ratio > minAspectRatio && ratio < maxAspectRatio) {
          bestArea = area;
          bestQuad = ordered;
        }
        candidateApprox.delete();
      }
      cnt.delete();
    }
    return bestQuad;
  } finally {
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (kernel) kernel.delete();
    if (hierarchy) hierarchy.delete();
    if (contours) contours.delete();
  }
}

// Computes per-image Canny thresholds based on the grayscale's mean
// brightness. Works far better than fixed numbers across lighting setups.
function adaptiveCannyThresholds(gray) {
  const cv = self.cv;
  const m = cv.mean(gray);
  const meanVal = m[0]; // 0..255
  const sigma = 0.33;
  const low = Math.max(10,  Math.round((1 - sigma) * meanVal));
  const high = Math.min(255, Math.round((1 + sigma) * meanVal));
  return { low, high };
}

// Multi-pass detection: adaptive first, then conservative fallbacks for
// unusual lighting. First pass that yields a valid quad wins.
function detectQuad(rgba, w, h, _opts = {}) {
  const cv = self.cv;
  if (!cv || !cv.imread) return null;

  let src, gray;
  try {
    src = new cv.Mat(h, w, cv.CV_8UC4);
    src.data.set(rgba);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const adaptive = adaptiveCannyThresholds(gray);
    const passes = [
      // 1. Adaptive: tracks the actual brightness of the current frame
      { cannyLow: adaptive.low, cannyHigh: adaptive.high, dilateIters: 1 },
      // 2. Low-contrast / dim lighting fallback
      { cannyLow: 20, cannyHigh: 60, dilateIters: 2 },
      // 3. High-contrast / very bright fallback
      { cannyLow: 80, cannyHigh: 200, dilateIters: 1 },
    ];
    for (const opts of passes) {
      const q = detectQuadOnce(gray, w, h, opts);
      if (q) return q;
    }
    return null;
  } catch (e) {
    self.postMessage({ type: 'detect-error', message: String(e && (e.message || e)) });
    return null;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'detect') {
    const quad = detectQuad(msg.rgba, msg.w, msg.h, msg.opts);
    self.postMessage({ type: 'detect-result', id: msg.id, quad });
  }
};
