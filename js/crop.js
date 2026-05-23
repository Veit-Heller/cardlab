// SCREEN 2: CROP / ADJUST CORNERS
// Generic crop editor used after each high-res capture. The caller provides
// the source image (a Canvas), a *suggested* quad (from the worker, in image
// coords), a side label for the UI, and a callback that gets the rectified
// canvas when the user confirms.

const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
let cropImgScale = 1, cropImgOffX = 0, cropImgOffY = 0;
let draggingCorner = null;
let cropOnConfirm = null;
let cropOnBack = null;

// Opens the crop editor with the given image + suggested quad. Returns nothing
// — completion is signalled via the onConfirm callback supplied in opts.
function openCropEditor(sourceImage, imgQuad, opts) {
  opts = opts || {};
  state.sourceImage = sourceImage;
  cropOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
  cropOnBack = typeof opts.onBack === 'function' ? opts.onBack : null;
  updateCropLabels(opts.sideLabel || 'Karte');
  unlockScreen('crop');
  showScreen('crop');
  // Wait one frame so the screen actually has dimensions before we lay out
  requestAnimationFrame(() => initCropLayout(imgQuad));
}

function updateCropLabels(sideLabel) {
  const h2 = document.querySelector('.crop-side h2');
  if (h2) h2.innerHTML = `${sideLabel} <em>justieren</em>.`;
  const btn = document.getElementById('confirmCrop');
  if (btn) {
    btn.textContent = sideLabel === 'Rückseite'
      ? 'Weiter zur Analyse →'
      : 'Weiter zur Rückseite →';
  }
}

function initCropLayout(imgQuad) {
  const rect = cropCanvas.parentElement.getBoundingClientRect();
  cropCanvas.width = Math.max(200, rect.width - 40);
  cropCanvas.height = Math.max(200, rect.height - 40);

  const img = state.sourceImage;
  const sc = Math.min(cropCanvas.width / img.width, cropCanvas.height / img.height);
  cropImgScale = sc;
  cropImgOffX = (cropCanvas.width - img.width * sc) / 2;
  cropImgOffY = (cropCanvas.height - img.height * sc) / 2;

  if (imgQuad && imgQuad.length === 4) {
    state.corners = imgQuad.map(p => ({
      x: cropImgOffX + p.x * sc,
      y: cropImgOffY + p.y * sc,
    }));
  } else {
    const iw = img.width * sc;
    const ih = img.height * sc;
    const inset = 0.12;
    state.corners = [
      { x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*inset },
      { x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*inset },
      { x: cropImgOffX + iw*(1-inset), y: cropImgOffY + ih*(1-inset) },
      { x: cropImgOffX + iw*inset,     y: cropImgOffY + ih*(1-inset) },
    ];
  }
  drawCrop();
}

window.addEventListener('resize', () => {
  if (state.currentScreen === 'crop' && state.sourceImage) {
    // Re-layout but preserve current image-space corner positions
    const oldCorners = state.corners.map(c => ({
      x: (c.x - cropImgOffX) / cropImgScale,
      y: (c.y - cropImgOffY) / cropImgScale,
    }));
    initCropLayout(oldCorners);
  }
});

function drawCrop() {
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  // Image
  cropCtx.drawImage(
    state.sourceImage,
    cropImgOffX, cropImgOffY,
    state.sourceImage.width * cropImgScale,
    state.sourceImage.height * cropImgScale
  );
  // Dim outside selection
  cropCtx.fillStyle = 'rgba(7,7,10,0.65)';
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

  // Outline
  cropCtx.strokeStyle = '#d4af6a';
  cropCtx.lineWidth = 1.5;
  cropCtx.setLineDash([6, 4]);
  cropCtx.beginPath();
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(state.corners[i].x, state.corners[i].y);
  cropCtx.closePath();
  cropCtx.stroke();
  cropCtx.setLineDash([]);

  // Corner handles (large enough for thumbs on mobile)
  state.corners.forEach(c => {
    cropCtx.fillStyle = '#07070a';
    cropCtx.strokeStyle = '#d4af6a';
    cropCtx.lineWidth = 2;
    cropCtx.beginPath();
    cropCtx.arc(c.x, c.y, 14, 0, Math.PI*2);
    cropCtx.fill();
    cropCtx.stroke();
    cropCtx.fillStyle = '#d4af6a';
    cropCtx.beginPath();
    cropCtx.arc(c.x, c.y, 4, 0, Math.PI*2);
    cropCtx.fill();
  });
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
  // Snap to nearest corner within touch radius
  let nearestI = -1, nearestD = 1e9;
  state.corners.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < 28 && d < nearestD) { nearestI = i; nearestD = d; }
  });
  draggingCorner = nearestI >= 0 ? nearestI : null;
}
function onCropMove(e) {
  if (draggingCorner === null) return;
  e.preventDefault();
  const p = getCanvasPos(e);
  // Clamp inside canvas
  state.corners[draggingCorner] = {
    x: Math.max(0, Math.min(cropCanvas.width, p.x)),
    y: Math.max(0, Math.min(cropCanvas.height, p.y)),
  };
  drawCrop();
}
function onCropUp() { draggingCorner = null; }
cropCanvas.addEventListener('mousedown', onCropDown);
cropCanvas.addEventListener('mousemove', onCropMove);
cropCanvas.addEventListener('mouseup', onCropUp);
cropCanvas.addEventListener('mouseleave', onCropUp);
cropCanvas.addEventListener('touchstart', onCropDown, { passive: false });
cropCanvas.addEventListener('touchmove', onCropMove, { passive: false });
cropCanvas.addEventListener('touchend', onCropUp);

// "Auto-detect corners" — re-run brightness heuristic on the current source image
document.getElementById('autoCorners').addEventListener('click', () => {
  const detected = detectCardCornersBrightness(state.sourceImage);
  if (detected) {
    state.corners = detected.map(p => ({
      x: cropImgOffX + p.x * cropImgScale,
      y: cropImgOffY + p.y * cropImgScale,
    }));
  } else {
    alert('Karte nicht automatisch erkennbar. Ecken bitte manuell ziehen.');
  }
  drawCrop();
});

// "Back" — return to scanner
document.getElementById('backToCapture').addEventListener('click', () => {
  if (cropOnBack) cropOnBack();
  else showScreen('capture');
});

// "Continue" — rectify, fire callback
document.getElementById('confirmCrop').addEventListener('click', () => {
  rectifyCard();
  if (cropOnConfirm) cropOnConfirm(state.rectifiedCanvas);
});

// ─────── Brightness-only auto-detect fallback (no OpenCV needed) ───────
function detectCardCornersBrightness(img) {
  const TARGET = 500;
  const ds = Math.min(1, TARGET / Math.max(img.width, img.height));
  const dw = Math.round(img.width * ds);
  const dh = Math.round(img.height * ds);
  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  c.getContext('2d').drawImage(img, 0, 0, dw, dh);
  const data = c.getContext('2d').getImageData(0, 0, dw, dh).data;
  const B = new Float32Array(dw * dh);
  for (let i = 0; i < dw*dh; i++) B[i] = (data[i*4] + data[i*4+1] + data[i*4+2]) / 3;
  function b(x, y) { return B[y * dw + x]; }
  function sampleBg(x0, y0) {
    let sum = 0, n = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) { sum += b(x0+dx, y0+dy); n++; }
    return sum / n;
  }
  const bgSamples = [sampleBg(0,0), sampleBg(dw-8,0), sampleBg(0,dh-8), sampleBg(dw-8,dh-8)];
  bgSamples.sort((a, b) => a - b);
  const bg = bgSamples[1];
  const T = 25;
  const leftEdge = new Int16Array(dh).fill(-1);
  const rightEdge = new Int16Array(dh).fill(-1);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) if (Math.abs(b(x,y) - bg) > T) { leftEdge[y] = x; break; }
    for (let x = dw-1; x >= 0; x--) if (Math.abs(b(x,y) - bg) > T) { rightEdge[y] = x; break; }
  }
  let topmostY = dh, bottommostY = 0;
  for (let y = 0; y < dh; y++) if (leftEdge[y] >= 0) { topmostY = y; break; }
  for (let y = dh-1; y >= 0; y--) if (leftEdge[y] >= 0) { bottommostY = y; break; }
  const w = (() => {
    let mn = dw, mx = 0;
    for (let y = 0; y < dh; y++) {
      if (leftEdge[y] >= 0) mn = Math.min(mn, leftEdge[y]);
      if (rightEdge[y] >= 0) mx = Math.max(mx, rightEdge[y]);
    }
    return mx - mn;
  })();
  if (w < dw * 0.3 || (bottommostY - topmostY) < dh * 0.3) return null;
  const topBand = Math.round((bottommostY - topmostY) * 0.15);
  let tlX = dw, tlY = topmostY, trX = 0, trY = topmostY;
  for (let y = topmostY; y < topmostY + topBand && y < dh; y++) {
    if (leftEdge[y] >= 0 && leftEdge[y] < tlX) { tlX = leftEdge[y]; tlY = y; }
    if (rightEdge[y] > trX) { trX = rightEdge[y]; trY = y; }
  }
  let blX = dw, blY = bottommostY, brX = 0, brY = bottommostY;
  for (let y = Math.max(0, bottommostY - topBand); y <= bottommostY; y++) {
    if (leftEdge[y] >= 0 && leftEdge[y] < blX) { blX = leftEdge[y]; blY = y; }
    if (rightEdge[y] > brX) { brX = rightEdge[y]; brY = y; }
  }
  const inv = 1 / ds;
  return [
    { x: tlX*inv, y: tlY*inv }, { x: trX*inv, y: trY*inv },
    { x: brX*inv, y: brY*inv }, { x: blX*inv, y: blY*inv },
  ];
}

// ─────── Perspective rectification ───────
// Pokémon card aspect 5:7. 1500×2100 ≈ 600 dpi.
function rectifyFromImageCorners(img, imgCorners, targetW = 1500, targetH = 2100) {
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d');
  const N = 40;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u0 = i/N, u1 = (i+1)/N;
      const v0 = j/N, v1 = (j+1)/N;
      const p00 = bilinear(imgCorners, u0, v0);
      const p10 = bilinear(imgCorners, u1, v0);
      const p11 = bilinear(imgCorners, u1, v1);
      const p01 = bilinear(imgCorners, u0, v1);
      drawTriangle(octx, img,
        u0*targetW, v0*targetH, u1*targetW, v0*targetH, u1*targetW, v1*targetH,
        p00.x, p00.y, p10.x, p10.y, p11.x, p11.y);
      drawTriangle(octx, img,
        u0*targetW, v0*targetH, u1*targetW, v1*targetH, u0*targetW, v1*targetH,
        p00.x, p00.y, p11.x, p11.y, p01.x, p01.y);
    }
  }
  return out;
}

function rectifyCard() {
  const imgCorners = state.corners.map(c => ({
    x: (c.x - cropImgOffX) / cropImgScale,
    y: (c.y - cropImgOffY) / cropImgScale,
  }));
  state.rectifiedCanvas = rectifyFromImageCorners(state.sourceImage, imgCorners);
}

function bilinear(c, u, v) {
  const top    = { x: c[0].x*(1-u) + c[1].x*u, y: c[0].y*(1-u) + c[1].y*u };
  const bottom = { x: c[3].x*(1-u) + c[2].x*u, y: c[3].y*(1-u) + c[2].y*u };
  return { x: top.x*(1-v) + bottom.x*v, y: top.y*(1-v) + bottom.y*v };
}

function drawTriangle(ctx, img, x0,y0, x1,y1, x2,y2, u0,v0, u1,v1, u2,v2) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();
  const m = solveAffine(u0,v0, u1,v1, u2,v2, x0,y0, x1,y1, x2,y2);
  if (!m) { ctx.restore(); return; }
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function solveAffine(u0,v0, u1,v1, u2,v2, x0,y0, x1,y1, x2,y2) {
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
