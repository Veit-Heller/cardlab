// OpenCV runs here in a Web Worker so its WASM compile and per-frame
// edge/contour pipeline don't block the main thread. We accept ImageData
// (RGBA bytes + dimensions) and return either a detected quad or null.

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

function detectQuad(rgba, w, h, opts = {}) {
  const cv = self.cv;
  if (!cv || !cv.imread) return null;

  const minAreaRatio = opts.minAreaRatio ?? 0.08;
  const maxAreaRatio = opts.maxAreaRatio ?? 0.95;
  const cannyLow = opts.cannyLow ?? 40;
  const cannyHigh = opts.cannyHigh ?? 120;
  const approxEpsilon = opts.approxEpsilon ?? 0.025;
  const minAspectRatio = opts.minAspectRatio ?? 0.5;
  const maxAspectRatio = opts.maxAspectRatio ?? 0.92;

  let src, gray, blurred, edges, kernel, hierarchy, contours;
  try {
    // Construct the Mat directly from the typed array. cv.matFromImageData
    // is fussy about the wrapper object shape, this is the safer path.
    src = new cv.Mat(h, w, cv.CV_8UC4);
    src.data.set(rgba);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, cannyLow, cannyHigh);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);

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
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, peri * approxEpsilon, true);
      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
        }
        const ordered = orderQuadCorners(pts);
        const wq = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
        const hq = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
        const ratio = Math.min(wq, hq) / Math.max(wq, hq);
        if (ratio > minAspectRatio && ratio < maxAspectRatio) {
          bestArea = area;
          bestQuad = ordered;
        }
      }
      approx.delete();
      cnt.delete();
    }
    return bestQuad;
  } catch (e) {
    // Surface errors back to the main thread so we can diagnose silent failures
    self.postMessage({ type: 'detect-error', message: String(e && (e.message || e)) });
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

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'detect') {
    const quad = detectQuad(msg.rgba, msg.w, msg.h, msg.opts);
    self.postMessage({ type: 'detect-result', id: msg.id, quad });
  }
};
