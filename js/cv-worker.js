// OpenCV runs here in a Web Worker so its WASM compile and per-frame
// edge/contour pipeline don't block the main thread. We accept ImageData
// (RGBA bytes + dimensions) and return either a detected quad or null.
//
// Detection strategy (multiple methods, first hit wins):
//   1. Adaptive threshold + morphological closing + outermost contour.
//      Robust on cards with busy interiors (the classic Canny mistake of
//      finding the inner logo-frame instead of the outer card edge).
//   2. Canny with adaptive thresholds — the original method, kept as a
//      fallback for high-contrast scenes.
// Across both: convex-hull cleanup so finger-occluded corners (5–6 vertex
// contours) can still snap to 4. Aspect ratio is tight (Pokémon card 5:7
// ≈ 0.714, accepted range 0.62–0.85) so inner text-boxes are rejected.

self.Module = {
  onRuntimeInitialized() {
    self.postMessage({ type: 'ready' });
  },
};

importScripts('https://docs.opencv.org/4.10.0/opencv.js');

const POKE_ASPECT_LOW = 0.62;   // tight enough to reject square-ish inner panels
const POKE_ASPECT_HIGH = 0.85;  // generous enough for perspective tilt

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

// Given a contour, try to fit a quad using literal approx, then via convex hull.
// Returns ordered 4-corner array {tl,tr,br,bl} or null. Respects aspect bounds.
function fitQuadFromContour(cnt, peri, opts) {
  const cv = self.cv;
  const {
    approxEpsilon = 0.04,
    minAspectRatio = POKE_ASPECT_LOW,
    maxAspectRatio = POKE_ASPECT_HIGH,
  } = opts;

  function check(approx) {
    if (approx.rows !== 4 || !cv.isContourConvex(approx)) return null;
    const pts = [];
    for (let r = 0; r < 4; r++) {
      pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
    }
    const ordered = orderQuadCorners(pts);
    const wq = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
    const hq = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
    const ratio = Math.min(wq, hq) / Math.max(wq, hq);
    if (ratio < minAspectRatio || ratio > maxAspectRatio) return null;
    return ordered;
  }

  let approx = new cv.Mat();
  cv.approxPolyDP(cnt, approx, peri * approxEpsilon, true);
  let quad = check(approx);
  if (quad) { approx.delete(); return quad; }
  if (approx.rows >= 4 && approx.rows <= 8) {
    // Convex-hull fallback: clean up finger-occluded contours
    approx.delete();
    const hull = new cv.Mat();
    cv.convexHull(cnt, hull, false, true);
    approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, peri * 0.06, true);
    quad = check(approx);
    hull.delete();
  }
  approx.delete();
  return quad;
}

// METHOD 1 — Adaptive threshold + morphological closing + outermost contour.
// Good for cards on plain backgrounds where the *whole card* is a connected
// region against the background, even if the card's interior is busy.
function detectViaAdaptiveThreshold(gray, w, h) {
  const cv = self.cv;
  let blurred, thresh, kernel, contours, hierarchy;
  try {
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    thresh = new cv.Mat();
    // blockSize must be odd. ~5% of image dimension keeps it scale-stable.
    const blockSize = Math.max(11, Math.round(Math.min(w, h) * 0.05) | 1);
    cv.adaptiveThreshold(
      blurred, thresh, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV,
      blockSize, 5
    );

    // Close gaps in the card border. The kernel needs to be big enough to
    // bridge typical break sizes — ~1.5% of image dimension works well.
    const ksize = Math.max(5, Math.round(Math.min(w, h) * 0.015) | 1);
    kernel = cv.Mat.ones(ksize, ksize, cv.CV_8U);
    cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = w * h;
    // Collect all reasonably sized contours, sorted by area descending
    const candidates = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area >= imgArea * 0.05 && area <= imgArea * 0.97) {
        candidates.push({ cnt, area, peri: cv.arcLength(cnt, true) });
      } else {
        cnt.delete();
      }
    }
    candidates.sort((a, b) => b.area - a.area);

    // Try largest first (outermost). Return first that fits Pokémon aspect.
    let result = null;
    for (const c of candidates) {
      if (!result) {
        const quad = fitQuadFromContour(c.cnt, c.peri, {});
        if (quad) result = quad;
      }
      c.cnt.delete();
    }
    return result;
  } finally {
    if (blurred) blurred.delete();
    if (thresh) thresh.delete();
    if (kernel) kernel.delete();
    if (hierarchy) hierarchy.delete();
    if (contours) contours.delete();
  }
}

// METHOD 2 — Canny + dilate + outermost contour, with adaptive thresholds.
// Catches high-contrast scenes where adaptive threshold over-segments.
function detectViaCanny(gray, w, h) {
  const cv = self.cv;
  const m = cv.mean(gray);
  const meanVal = m[0];
  const sigma = 0.33;
  const passes = [
    { low: Math.max(10, Math.round((1 - sigma) * meanVal)),
      high: Math.min(255, Math.round((1 + sigma) * meanVal)),
      dilateIters: 1 },
    { low: 20, high: 60, dilateIters: 2 },
    { low: 80, high: 200, dilateIters: 1 },
  ];

  for (const p of passes) {
    let blurred, edges, kernel, contours, hierarchy;
    try {
      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      edges = new cv.Mat();
      cv.Canny(blurred, edges, p.low, p.high);
      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      for (let k = 0; k < p.dilateIters; k++) cv.dilate(edges, edges, kernel);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const imgArea = w * h;
      const candidates = [];
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area >= imgArea * 0.05 && area <= imgArea * 0.97) {
          candidates.push({ cnt, area, peri: cv.arcLength(cnt, true) });
        } else {
          cnt.delete();
        }
      }
      candidates.sort((a, b) => b.area - a.area);

      let result = null;
      for (const c of candidates) {
        if (!result) {
          const quad = fitQuadFromContour(c.cnt, c.peri, {});
          if (quad) result = quad;
        }
        c.cnt.delete();
      }
      if (result) return result;
    } finally {
      if (blurred) blurred.delete();
      if (edges) edges.delete();
      if (kernel) kernel.delete();
      if (hierarchy) hierarchy.delete();
      if (contours) contours.delete();
    }
  }
  return null;
}

function detectQuad(rgba, w, h) {
  const cv = self.cv;
  if (!cv || !cv.imread) return null;

  let src, gray;
  try {
    src = new cv.Mat(h, w, cv.CV_8UC4);
    src.data.set(rgba);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Method 1: adaptive threshold (better for cards with busy interiors)
    let quad = detectViaAdaptiveThreshold(gray, w, h);
    if (quad) return quad;

    // Method 2: Canny (fallback for high-contrast scenes)
    quad = detectViaCanny(gray, w, h);
    return quad;
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
    const quad = detectQuad(msg.rgba, msg.w, msg.h);
    self.postMessage({ type: 'detect-result', id: msg.id, quad });
  }
};
