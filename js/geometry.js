// Quad geometry helpers shared by scan.js (live frame detection) and crop.js
// (still-image detection).

function dist(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }

// Sort 4 points as TL, TR, BR, BL using sum/diff of coords (classic trick).
// TL = min(x+y), BR = max(x+y), TR = min(y-x), BL = max(y-x).
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
