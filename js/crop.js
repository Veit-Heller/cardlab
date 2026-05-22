// SCREEN 2: CROP / ADJUST CORNERS
// Show the captured photo with 4 draggable corners. Auto-detect via OpenCV
// (primary) or a brightness heuristic (fallback). Confirm → perspective-rectify
// to a 500×700 canvas and continue to analysis.

const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
let cropImgScale = 1, cropImgOffX = 0, cropImgOffY = 0;
let draggingCorner = null;

async function initCropScreen() {
  const rect = cropCanvas.parentElement.getBoundingClientRect();
  cropCanvas.width = rect.width - 40;
  cropCanvas.height = rect.height - 40;

  // Fit image to canvas
  const img = state.sourceImage;
  const sc = Math.min(cropCanvas.width / img.width, cropCanvas.height / img.height);
  cropImgScale = sc;
  cropImgOffX = (cropCanvas.width - img.width * sc) / 2;
  cropImgOffY = (cropCanvas.height - img.height * sc) / 2;

  // Start with a generous default while we attempt detection
  const iw = img.width * sc;
  const ih = img.height * sc;
  const inset = 0.12;
  state.corners = [
    {x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*inset},
    {x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*inset},
    {x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*(1-inset)},
    {x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*(1-inset)},
  ];
  drawCrop();

  // Run the cheap brightness heuristic synchronously to pre-place the corners.
  // We deliberately don't run OpenCV here — its WASM compile (~10MB) blocked
  // the main thread enough that Chrome popped a "page not responding" dialog.
  // The user can click "Auto-detect corners" to opt into the heavier CV pass.
  const detected = detectCardCorners(img);
  if (detected) {
    state.corners = detected.map(p => ({
      x: cropImgOffX + p.x * sc,
      y: cropImgOffY + p.y * sc,
    }));
    drawCrop();
  }
}

// ─────── OpenCV.js based card detection ───────
// Workflow:
//   1. Downsample (speed)
//   2. Grayscale → blur → Canny edges → dilate
//   3. findContours → keep large ones
//   4. For each contour: approxPolyDP, keep those with 4 vertices & convex
//   5. Choose the largest one with reasonable aspect ratio (card-like)
//   6. Sort the 4 vertices as TL, TR, BR, BL
async function detectCardWithCV(img, timeoutMs = 8000) {
  let cv;
  try {
    cv = await Promise.race([
      loadOpenCV(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cv timeout')), timeoutMs)),
    ]);
  } catch (e) {
    return null; // OpenCV not available
  }
  if (!cv || !cv.imread) return null;

  // Downsample
  const TARGET = 800;
  const scale = Math.min(1, TARGET / Math.max(img.width, img.height));
  const dw = Math.round(img.width * scale);
  const dh = Math.round(img.height * scale);
  const tmp = document.createElement('canvas');
  tmp.width = dw; tmp.height = dh;
  tmp.getContext('2d').drawImage(img, 0, 0, dw, dh);

  let src, gray, blurred, edges, kernel, hierarchy, contours;
  try {
    src = cv.imread(tmp);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    // Dilate to close gaps in the card border
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestQuad = null;
    let bestArea = 0;
    const imgArea = dw * dh;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      // Must be a meaningful portion of the image
      if (area < imgArea * 0.1 || area > imgArea * 0.99) {
        cnt.delete();
        continue;
      }
      // Approximate to polygon
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, peri * 0.02, true);

      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        // Aspect ratio check: card is ~5:7
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.data32S[r*2], y: approx.data32S[r*2+1] });
        }
        const ordered = orderQuadCorners(pts);
        const w = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
        const h = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
        const ratio = Math.min(w, h) / Math.max(w, h);
        // Pokemon card ratio ≈ 5/7 ≈ 0.714. Allow 0.55–0.85 to be tolerant.
        if (ratio > 0.55 && ratio < 0.9) {
          bestArea = area;
          bestQuad = ordered;
        }
      }
      approx.delete();
      cnt.delete();
    }

    if (!bestQuad) return null;

    // Convert back to original image coordinates
    const inv = 1 / scale;
    return bestQuad.map(p => ({ x: p.x * inv, y: p.y * inv }));
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

// ─────── Auto card-corner detection (fallback heuristic) ───────
// Strategy: downsample image, compute brightness, scan each row & column
// inwards from the borders looking for the first significant brightness shift.
// The points where the shifts happen form the card's bounding region;
// from there we derive 4 corners via the extremes per side.
function detectCardCorners(img) {
  // Downsample for performance & noise reduction
  const TARGET = 500;
  const ds = Math.min(1, TARGET / Math.max(img.width, img.height));
  const dw = Math.round(img.width * ds);
  const dh = Math.round(img.height * ds);

  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0, dw, dh);
  const data = cx.getImageData(0, 0, dw, dh).data;

  // Brightness lookup
  const B = new Float32Array(dw * dh);
  for (let i = 0; i < dw*dh; i++) {
    B[i] = (data[i*4] + data[i*4+1] + data[i*4+2]) / 3;
  }
  function b(x, y) { return B[y * dw + x]; }

  // Sample the background brightness from the 4 outer corners of the photo
  // (the assumption: those are NOT the card itself)
  function sampleBg(x0, y0) {
    let sum = 0, n = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      sum += b(x0+dx, y0+dy); n++;
    }
    return sum / n;
  }
  const bgSamples = [
    sampleBg(0, 0),
    sampleBg(dw-8, 0),
    sampleBg(0, dh-8),
    sampleBg(dw-8, dh-8),
  ];
  // Use median bg to be robust to one corner being card
  const bgSorted = [...bgSamples].sort((a,b)=>a-b);
  const bg = bgSorted[1]; // 2nd value, closer to median for 4 samples

  // For each row, find leftmost & rightmost pixel that differs from bg.
  // For each col, find topmost & bottommost.
  // Threshold: >25 brightness units away from bg.
  const THRESHOLD = 25;
  const leftEdge = new Int16Array(dh).fill(-1);
  const rightEdge = new Int16Array(dh).fill(-1);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (Math.abs(b(x, y) - bg) > THRESHOLD) { leftEdge[y] = x; break; }
    }
    for (let x = dw-1; x >= 0; x--) {
      if (Math.abs(b(x, y) - bg) > THRESHOLD) { rightEdge[y] = x; break; }
    }
  }
  const topEdge = new Int16Array(dw).fill(-1);
  const botEdge = new Int16Array(dw).fill(-1);
  for (let x = 0; x < dw; x++) {
    for (let y = 0; y < dh; y++) {
      if (Math.abs(b(x, y) - bg) > THRESHOLD) { topEdge[x] = y; break; }
    }
    for (let y = dh-1; y >= 0; y--) {
      if (Math.abs(b(x, y) - bg) > THRESHOLD) { botEdge[x] = y; break; }
    }
  }

  // Now find the overall bounding box of the foreground "card region"
  let minX = dw, maxX = 0, minY = dh, maxY = 0;
  let fgCount = 0;
  for (let y = 0; y < dh; y++) {
    if (leftEdge[y] >= 0) { minX = Math.min(minX, leftEdge[y]); fgCount++; }
    if (rightEdge[y] >= 0) maxX = Math.max(maxX, rightEdge[y]);
  }
  for (let x = 0; x < dw; x++) {
    if (topEdge[x] >= 0) minY = Math.min(minY, topEdge[x]);
    if (botEdge[x] >= 0) maxY = Math.max(maxY, botEdge[x]);
  }

  // Sanity checks: card should occupy a reasonable portion of the photo
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < dw * 0.3 || h < dh * 0.3) return null; // too small, detection failed
  if (w > dw * 0.99 || h > dh * 0.99) return null; // hit the whole image, no border
  if (fgCount < dh * 0.3) return null; // too few foreground rows

  // Try to fit a tighter quadrilateral by finding the actual corners.
  // Strategy: for each side, find the extreme point along the perpendicular
  // direction. This handles slightly tilted cards better than just a bbox.

  // Top side: among all (x, topEdge[x]) where defined, take leftmost & rightmost
  let topLeft = null, topRight = null, botLeft = null, botRight = null;
  // We pick corner points from row-wise edges since cards are taller than wide
  // and rows give more samples for tilted cards.

  // Find the topmost row that has any foreground (≈ top of the card)
  let topmostY = dh, bottommostY = 0;
  for (let y = 0; y < dh; y++) if (leftEdge[y] >= 0) { topmostY = y; break; }
  for (let y = dh-1; y >= 0; y--) if (leftEdge[y] >= 0) { bottommostY = y; break; }

  // For TL & TR: look in the top 15% of card rows
  const topBand = Math.round((bottommostY - topmostY) * 0.15);
  let tlX = dw, tlY = topmostY, trX = 0, trY = topmostY;
  for (let y = topmostY; y < topmostY + topBand && y < dh; y++) {
    if (leftEdge[y] >= 0 && leftEdge[y] < tlX) { tlX = leftEdge[y]; tlY = y; }
    if (rightEdge[y] > trX) { trX = rightEdge[y]; trY = y; }
  }
  // For BL & BR: bottom 15%
  let blX = dw, blY = bottommostY, brX = 0, brY = bottommostY;
  for (let y = Math.max(0, bottommostY - topBand); y <= bottommostY; y++) {
    if (leftEdge[y] >= 0 && leftEdge[y] < blX) { blX = leftEdge[y]; blY = y; }
    if (rightEdge[y] > brX) { brX = rightEdge[y]; brY = y; }
  }

  // Convert back to original image coordinates
  const inv = 1 / ds;
  return [
    {x: tlX * inv, y: tlY * inv}, // TL
    {x: trX * inv, y: trY * inv}, // TR
    {x: brX * inv, y: brY * inv}, // BR
    {x: blX * inv, y: blY * inv}, // BL
  ];
}

window.addEventListener('resize', () => {
  if (state.currentScreen === 'crop' && state.sourceImage) initCropScreen();
});

function drawCrop(detecting = false) {
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  // Image
  cropCtx.drawImage(
    state.sourceImage,
    cropImgOffX, cropImgOffY,
    state.sourceImage.width * cropImgScale,
    state.sourceImage.height * cropImgScale
  );
  // Dim outside selection
  cropCtx.fillStyle = 'rgba(7,7,10,0.6)';
  cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  // Cut hole for selection
  cropCtx.save();
  cropCtx.globalCompositeOperation = 'destination-out';
  cropCtx.beginPath();
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(state.corners[i].x, state.corners[i].y);
  cropCtx.closePath();
  cropCtx.fill();
  cropCtx.restore();
  // Re-draw image inside selection
  cropCtx.save();
  cropCtx.beginPath();
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(state.corners[i].x, state.corners[i].y);
  cropCtx.closePath();
  cropCtx.clip();
  cropCtx.drawImage(
    state.sourceImage,
    cropImgOffX, cropImgOffY,
    state.sourceImage.width * cropImgScale,
    state.sourceImage.height * cropImgScale
  );
  cropCtx.restore();

  // Polygon outline
  cropCtx.strokeStyle = '#d4af6a';
  cropCtx.lineWidth = 1.5;
  cropCtx.setLineDash([6, 4]);
  cropCtx.beginPath();
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(state.corners[i].x, state.corners[i].y);
  cropCtx.closePath();
  cropCtx.stroke();
  cropCtx.setLineDash([]);

  // Corner handles
  state.corners.forEach((c, i) => {
    cropCtx.fillStyle = '#07070a';
    cropCtx.strokeStyle = '#d4af6a';
    cropCtx.lineWidth = 2;
    cropCtx.beginPath();
    cropCtx.arc(c.x, c.y, 10, 0, Math.PI*2);
    cropCtx.fill();
    cropCtx.stroke();
    // Inner dot
    cropCtx.fillStyle = '#d4af6a';
    cropCtx.beginPath();
    cropCtx.arc(c.x, c.y, 3, 0, Math.PI*2);
    cropCtx.fill();
  });

  // "Detecting…" banner during initial CV detection
  if (detecting) {
    cropCtx.fillStyle = 'rgba(7,7,10,0.7)';
    cropCtx.fillRect(0, cropCanvas.height/2 - 22, cropCanvas.width, 44);
    cropCtx.fillStyle = '#6affe3';
    cropCtx.font = '12px "JetBrains Mono", monospace';
    cropCtx.textAlign = 'center';
    cropCtx.fillText('◌  DETECTING CARD EDGES…', cropCanvas.width/2, cropCanvas.height/2 + 4);
    cropCtx.textAlign = 'start';
  }
}

function getCanvasPos(e) {
  const r = cropCanvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return {
    x: (t.clientX - r.left) * (cropCanvas.width / r.width),
    y: (t.clientY - r.top) * (cropCanvas.height / r.height),
  };
}
function onCropDown(e) {
  e.preventDefault();
  const p = getCanvasPos(e);
  state.corners.forEach((c, i) => {
    if (Math.hypot(c.x - p.x, c.y - p.y) < 20) draggingCorner = i;
  });
}
function onCropMove(e) {
  if (draggingCorner === null) return;
  e.preventDefault();
  const p = getCanvasPos(e);
  state.corners[draggingCorner] = {x: p.x, y: p.y};
  drawCrop();
}
function onCropUp() { draggingCorner = null; }
cropCanvas.addEventListener('mousedown', onCropDown);
cropCanvas.addEventListener('mousemove', onCropMove);
cropCanvas.addEventListener('mouseup', onCropUp);
cropCanvas.addEventListener('mouseleave', onCropUp);
cropCanvas.addEventListener('touchstart', onCropDown, {passive: false});
cropCanvas.addEventListener('touchmove', onCropMove, {passive: false});
cropCanvas.addEventListener('touchend', onCropUp);

document.getElementById('autoCorners').addEventListener('click', async () => {
  drawCrop(true);
  let detected = null;
  try { detected = await detectCardWithCV(state.sourceImage); } catch(e) {}
  if (!detected) detected = detectCardCorners(state.sourceImage);
  if (detected) {
    state.corners = detected.map(p => ({
      x: cropImgOffX + p.x * cropImgScale,
      y: cropImgOffY + p.y * cropImgScale,
    }));
  } else {
    const iw = state.sourceImage.width * cropImgScale;
    const ih = state.sourceImage.height * cropImgScale;
    const inset = 0.1;
    state.corners = [
      {x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*inset},
      {x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*inset},
      {x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*(1-inset)},
      {x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*(1-inset)},
    ];
    alert("Couldn't auto-detect the card. Drag the corners manually.");
  }
  drawCrop();
});

document.getElementById('backToCapture').addEventListener('click', () => {
  showScreen('capture');
});

document.getElementById('confirmCrop').addEventListener('click', () => {
  rectifyCard();
  unlockScreen('analysis');
  showScreen('analysis');
  startAnalysis();
});

// ─────── Perspective rectification ───────
// Standard Pokémon card aspect ratio: 2.5 x 3.5 inches = 5:7
function rectifyCard() {
  const targetW = 500, targetH = 700;
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d');

  // Convert canvas-coordinates to image-coordinates
  const imgCorners = state.corners.map(c => ({
    x: (c.x - cropImgOffX) / cropImgScale,
    y: (c.y - cropImgOffY) / cropImgScale,
  }));

  // We'll use a quad-warp by slicing into a grid and drawing each cell as a triangle.
  // This is the classic "no-WebGL perspective warp" trick.
  const N = 40; // grid resolution
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u0 = i/N, u1 = (i+1)/N;
      const v0 = j/N, v1 = (j+1)/N;

      // Bilinear interpolation of source corners
      const p00 = bilinear(imgCorners, u0, v0);
      const p10 = bilinear(imgCorners, u1, v0);
      const p11 = bilinear(imgCorners, u1, v1);
      const p01 = bilinear(imgCorners, u0, v1);

      // Two triangles per cell
      drawTriangle(octx, state.sourceImage,
        u0*targetW, v0*targetH, u1*targetW, v0*targetH, u1*targetW, v1*targetH,
        p00.x, p00.y, p10.x, p10.y, p11.x, p11.y);
      drawTriangle(octx, state.sourceImage,
        u0*targetW, v0*targetH, u1*targetW, v1*targetH, u0*targetW, v1*targetH,
        p00.x, p00.y, p11.x, p11.y, p01.x, p01.y);
    }
  }

  state.rectifiedCanvas = out;
}

function bilinear(c, u, v) {
  // c = [TL, TR, BR, BL]
  const top    = {x: c[0].x*(1-u) + c[1].x*u, y: c[0].y*(1-u) + c[1].y*u};
  const bottom = {x: c[3].x*(1-u) + c[2].x*u, y: c[3].y*(1-u) + c[2].y*u};
  return {
    x: top.x*(1-v) + bottom.x*v,
    y: top.y*(1-v) + bottom.y*v,
  };
}

function drawTriangle(ctx, img, x0,y0, x1,y1, x2,y2, u0,v0, u1,v1, u2,v2) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();

  // Compute affine transform mapping (u,v) → (x,y)
  const denom = u0*(v1-v2) - v0*(u1-u2) + u1*v2 - u2*v1;
  if (Math.abs(denom) < 1e-10) { ctx.restore(); return; }
  const a = (x0*(v1-v2) - v0*(x1-x2) + (v0*x2 - v2*x0) + (v2*x1 - v1*x2)) / denom;
  // Simpler approach: use matrix solve.
  // [x] = [a c e][u]
  // [y] = [b d f][v]
  //              [1]
  const m = solveAffine(u0,v0, u1,v1, u2,v2, x0,y0, x1,y1, x2,y2);
  if (!m) { ctx.restore(); return; }
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function solveAffine(u0,v0, u1,v1, u2,v2, x0,y0, x1,y1, x2,y2) {
  // Solve for [a c e; b d f] s.t. [u v 1] * M^T = [x y]
  const det = u0*(v1 - v2) - v0*(u1 - u2) + (u1*v2 - u2*v1);
  if (Math.abs(det) < 1e-10) return null;
  const a = (x0*(v1-v2) + x1*(v2-v0) + x2*(v0-v1)) / det;
  const c = (x0*(u2-u1) + x1*(u0-u2) + x2*(u1-u0)) / det;
  const e = (x0*(u1*v2-u2*v1) + x1*(u2*v0-u0*v2) + x2*(u0*v1-u1*v0)) / det;
  const b = (y0*(v1-v2) + y1*(v2-v0) + y2*(v0-v1)) / det;
  const d = (y0*(u2-u1) + y1*(u0-u2) + y2*(u1-u0)) / det;
  const f = (y0*(u1*v2-u2*v1) + y1*(u2*v0-u0*v2) + y2*(u0*v1-u1*v0)) / det;
  return [a, b, c, d, e, f];
}
