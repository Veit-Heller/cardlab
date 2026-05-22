// SCREEN 3: ANALYSIS
// Sequentially runs 4 checks on the rectified card (centering, corners, edges,
// surface), each drawing an overlay + producing a 0–1 score, then computes a
// weighted PSA-style grade.

const analysisCanvas = document.getElementById('analysisCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const scanLine = document.getElementById('scanLine');
const statusEl = document.getElementById('analysisStatus');

function setStatus(msg) { statusEl.textContent = msg; }

function startAnalysis() {
  // Set canvases to match card dimensions
  const W = 500, H = 700;
  analysisCanvas.width = W;
  analysisCanvas.height = H;
  overlayCanvas.width = W;
  overlayCanvas.height = H;
  const ctx = analysisCanvas.getContext('2d');
  const octx = overlayCanvas.getContext('2d');
  octx.clearRect(0, 0, W, H);
  ctx.drawImage(state.rectifiedCanvas, 0, 0, W, H);

  // Reset UI
  ['centering', 'corners', 'edges', 'surface'].forEach(k => {
    const row = document.getElementById('check-' + k);
    row.classList.remove('active', 'done');
    row.querySelector('.check-value').innerHTML = '—';
    row.querySelector('.check-icon').textContent = '◇';
  });
  document.getElementById('finalScore').classList.remove('show');

  // Run sequentially
  runScans();
}

async function runScans() {
  setStatus('▶ Initiating inspection sequence…');
  await wait(400);

  // 1. Centering
  await runCheck('centering', analyzeCentering, 'Measuring borders…');
  // 2. Corners
  await runCheck('corners', analyzeCorners, 'Inspecting corners…');
  // 3. Edges
  await runCheck('edges', analyzeEdges, 'Tracing edges…');
  // 4. Surface
  await runCheck('surface', analyzeSurface, 'Scanning surface…');

  await wait(300);
  computeFinalScore();
  setStatus('✓ Inspection complete.');
}

async function runCheck(key, fn, statusMsg) {
  const row = document.getElementById('check-' + key);
  row.classList.add('active');
  row.querySelector('.check-icon').textContent = '◌';
  setStatus(statusMsg);
  scanLine.classList.remove('active');
  void scanLine.offsetWidth; // restart animation
  scanLine.classList.add('active');
  await wait(2500);
  scanLine.classList.remove('active');

  const result = await fn();
  state.analysisResults = state.analysisResults || {};
  state.analysisResults[key] = result;

  row.classList.remove('active');
  row.classList.add('done');
  row.querySelector('.check-icon').textContent = '✓';
  row.querySelector('.check-value').innerHTML = result.display;
  await wait(300);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────── Real-ish analysis algorithms ───────
// All operate on the rectified card canvas data.

function getImageData() {
  const ctx = analysisCanvas.getContext('2d');
  return ctx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
}

function clearOverlay() {
  const o = overlayCanvas.getContext('2d');
  o.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// CENTERING: find inner frame by looking for the biggest color shift moving
// inward from each edge. We sample lines and find the first big gradient.
function analyzeCentering() {
  const data = getImageData();
  const W = data.width, H = data.height;
  const px = data.data;

  function brightness(x, y) {
    const i = (y * W + x) * 4;
    return (px[i] + px[i+1] + px[i+2]) / 3;
  }

  function findEdgeFromTop() {
    const samples = [];
    for (let x = W*0.3; x < W*0.7; x += 5) {
      let prev = brightness(x|0, 5);
      for (let y = 5; y < H/2; y++) {
        const b = brightness(x|0, y);
        if (Math.abs(b - prev) > 35) { samples.push(y); break; }
        prev = b;
      }
    }
    return median(samples) || H*0.06;
  }
  function findEdgeFromBottom() {
    const samples = [];
    for (let x = W*0.3; x < W*0.7; x += 5) {
      let prev = brightness(x|0, H-6);
      for (let y = H-6; y > H/2; y--) {
        const b = brightness(x|0, y);
        if (Math.abs(b - prev) > 35) { samples.push(H - y); break; }
        prev = b;
      }
    }
    return median(samples) || H*0.06;
  }
  function findEdgeFromLeft() {
    const samples = [];
    for (let y = H*0.3; y < H*0.7; y += 5) {
      let prev = brightness(5, y|0);
      for (let x = 5; x < W/2; x++) {
        const b = brightness(x, y|0);
        if (Math.abs(b - prev) > 35) { samples.push(x); break; }
        prev = b;
      }
    }
    return median(samples) || W*0.06;
  }
  function findEdgeFromRight() {
    const samples = [];
    for (let y = H*0.3; y < H*0.7; y += 5) {
      let prev = brightness(W-6, y|0);
      for (let x = W-6; x > W/2; x--) {
        const b = brightness(x, y|0);
        if (Math.abs(b - prev) > 35) { samples.push(W - x); break; }
        prev = b;
      }
    }
    return median(samples) || W*0.06;
  }

  const top = findEdgeFromTop();
  const bottom = findEdgeFromBottom();
  const left = findEdgeFromLeft();
  const right = findEdgeFromRight();

  // Calc ratios (smaller/larger so always ≤1)
  const hRatio = Math.min(left, right) / Math.max(left, right);
  const vRatio = Math.min(top, bottom) / Math.max(top, bottom);
  const score = (hRatio + vRatio) / 2;
  // Translate to letter score
  let grade, color;
  if (score > 0.9) { grade = 'Excellent'; color = 'score-mint'; }
  else if (score > 0.78) { grade = 'Good'; color = 'score-good'; }
  else { grade = 'Off-center'; color = 'score-low'; }

  // Draw overlay: green centering lines
  const o = overlayCanvas.getContext('2d');
  o.strokeStyle = 'rgba(95,220,140,0.8)';
  o.lineWidth = 1.5;
  o.setLineDash([4, 3]);
  // Vertical guide lines at left & right inner edges
  o.beginPath();
  o.moveTo(left, 0); o.lineTo(left, H);
  o.moveTo(W-right, 0); o.lineTo(W-right, H);
  o.moveTo(0, top); o.lineTo(W, top);
  o.moveTo(0, H-bottom); o.lineTo(W, H-bottom);
  o.stroke();
  o.setLineDash([]);
  // Labels
  o.font = '11px "JetBrains Mono", monospace';
  o.fillStyle = 'rgba(95,220,140,0.95)';
  o.fillText(left.toFixed(0)+'px', left+4, 16);
  o.fillText(right.toFixed(0)+'px', W-right-50, 16);
  o.fillText(top.toFixed(0)+'px', 6, top+14);
  o.fillText(bottom.toFixed(0)+'px', 6, H-bottom-6);

  const hPct = Math.round(left / (left+right) * 100);
  return {
    score,
    display: `<span class="check-score ${color}">${(score*10).toFixed(1)}</span><div style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.15em;">${hPct}/${100-hPct} · ${grade}</div>`
  };
}

// CORNERS: examine 4 corner regions, look for brightness deviation
// (whitening = light pixels at the cut edge).
function analyzeCorners() {
  const data = getImageData();
  const W = data.width, H = data.height;
  const px = data.data;
  const cornerSize = 60;

  function cornerWhitening(cx, cy) {
    // Look at the outer edge pixels of the corner region — count bright pixels
    let brightCount = 0, total = 0;
    for (let dx = 0; dx < cornerSize; dx++) {
      for (let dy = 0; dy < cornerSize; dy++) {
        // Only edge band
        if (dx > 4 && dy > 4) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const i = (y * W + x) * 4;
        const b = (px[i] + px[i+1] + px[i+2]) / 3;
        if (b > 220) brightCount++;
        total++;
      }
    }
    return brightCount / total;
  }

  const corners = [
    cornerWhitening(0, 0),
    cornerWhitening(W-cornerSize, 0),
    cornerWhitening(W-cornerSize, H-cornerSize),
    cornerWhitening(0, H-cornerSize),
  ];

  // Score: lower whitening = better. Typical 0..0.4
  const avgWhite = corners.reduce((a,b) => a+b, 0) / 4;
  const score = Math.max(0, 1 - avgWhite * 2);
  let grade, color;
  if (score > 0.85) { grade = 'Sharp'; color = 'score-mint'; }
  else if (score > 0.65) { grade = 'Light wear'; color = 'score-good'; }
  else { grade = 'Worn'; color = 'score-low'; }

  // Overlay: highlight corners
  const o = overlayCanvas.getContext('2d');
  const positions = [[0,0], [W-cornerSize,0], [W-cornerSize,H-cornerSize], [0,H-cornerSize]];
  positions.forEach((p, i) => {
    o.strokeStyle = corners[i] > 0.15 ? 'rgba(255,82,82,0.9)' : 'rgba(212,175,106,0.85)';
    o.lineWidth = 2;
    o.strokeRect(p[0]+2, p[1]+2, cornerSize-4, cornerSize-4);
    // L-shape decoration in the actual corner
    o.beginPath();
    const cx = p[0] < W/2 ? p[0]+8 : p[0]+cornerSize-8;
    const cy = p[1] < H/2 ? p[1]+8 : p[1]+cornerSize-8;
    const dx = p[0] < W/2 ? 1 : -1;
    const dy = p[1] < H/2 ? 1 : -1;
    o.moveTo(cx, cy);
    o.lineTo(cx + dx*16, cy);
    o.moveTo(cx, cy);
    o.lineTo(cx, cy + dy*16);
    o.stroke();
  });

  return {
    score,
    display: `<span class="check-score ${color}">${(score*10).toFixed(1)}</span><div style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.15em;">${grade}</div>`
  };
}

// EDGES: scan along the 4 edges, count brightness anomalies (nicks)
function analyzeEdges() {
  const data = getImageData();
  const W = data.width, H = data.height;
  const px = data.data;
  const edgeBand = 4;

  function brightness(x, y) {
    const i = (y * W + x) * 4;
    return (px[i] + px[i+1] + px[i+2]) / 3;
  }

  let anomalies = 0, samples = 0;
  const hits = [];
  // Top & bottom edges
  for (let x = 10; x < W-10; x++) {
    for (let band = 0; band < edgeBand; band++) {
      const bTop = brightness(x, band);
      const bRefTop = brightness(x, edgeBand+3);
      if (Math.abs(bTop - bRefTop) > 60 && bTop > 230) { anomalies++; hits.push([x, band]); }
      samples++;
      const bBot = brightness(x, H-1-band);
      const bRefBot = brightness(x, H-edgeBand-4);
      if (Math.abs(bBot - bRefBot) > 60 && bBot > 230) { anomalies++; hits.push([x, H-1-band]); }
      samples++;
    }
  }
  // Left & right edges
  for (let y = 10; y < H-10; y++) {
    for (let band = 0; band < edgeBand; band++) {
      const bL = brightness(band, y);
      const bRefL = brightness(edgeBand+3, y);
      if (Math.abs(bL - bRefL) > 60 && bL > 230) { anomalies++; hits.push([band, y]); }
      samples++;
      const bR = brightness(W-1-band, y);
      const bRefR = brightness(W-edgeBand-4, y);
      if (Math.abs(bR - bRefR) > 60 && bR > 230) { anomalies++; hits.push([W-1-band, y]); }
      samples++;
    }
  }

  const anomalyRate = anomalies / samples;
  const score = Math.max(0, 1 - anomalyRate * 30);
  let grade, color;
  if (score > 0.9) { grade = 'Clean'; color = 'score-mint'; }
  else if (score > 0.7) { grade = 'Minor nicks'; color = 'score-good'; }
  else { grade = 'Chipping'; color = 'score-low'; }

  // Overlay
  const o = overlayCanvas.getContext('2d');
  o.strokeStyle = 'rgba(106,255,227,0.4)';
  o.lineWidth = 1;
  o.strokeRect(2, 2, W-4, H-4);
  o.fillStyle = 'rgba(255,82,82,0.7)';
  hits.slice(0, 80).forEach(h => {
    o.beginPath();
    o.arc(h[0], h[1], 3, 0, Math.PI*2);
    o.fill();
  });

  return {
    score,
    display: `<span class="check-score ${color}">${(score*10).toFixed(1)}</span><div style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.15em;">${hits.length} flag${hits.length===1?'':'s'} · ${grade}</div>`
  };
}

// SURFACE: scan inner area, count specks (outliers vs local mean)
function analyzeSurface() {
  const data = getImageData();
  const W = data.width, H = data.height;
  const px = data.data;
  const innerL = 40, innerR = W-40, innerT = 60, innerB = H-60;
  let specks = 0, samples = 0;
  const hits = [];

  function brightness(x, y) {
    const i = (y * W + x) * 4;
    return (px[i] + px[i+1] + px[i+2]) / 3;
  }

  // Local contrast: compare each pixel to mean of 7x7 neighborhood
  for (let y = innerT; y < innerB; y += 3) {
    for (let x = innerL; x < innerR; x += 3) {
      let sum = 0, cnt = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          sum += brightness(x+dx, y+dy);
          cnt++;
        }
      }
      const mean = sum / cnt;
      const here = brightness(x, y);
      if (Math.abs(here - mean) > 50) {
        specks++;
        hits.push([x, y]);
      }
      samples++;
    }
  }
  const speckRate = specks / samples;
  const score = Math.max(0, 1 - speckRate * 8);
  let grade, color;
  if (score > 0.85) { grade = 'Pristine'; color = 'score-mint'; }
  else if (score > 0.65) { grade = 'Some marks'; color = 'score-good'; }
  else { grade = 'Visible flaws'; color = 'score-low'; }

  // Overlay
  const o = overlayCanvas.getContext('2d');
  o.fillStyle = 'rgba(255,95,179,0.6)';
  hits.slice(0, 30).forEach(h => {
    o.beginPath();
    o.arc(h[0], h[1], 4, 0, Math.PI*2);
    o.fill();
  });

  return {
    score,
    display: `<span class="check-score ${color}">${(score*10).toFixed(1)}</span><div style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.15em;">${hits.length} spot${hits.length===1?'':'s'} · ${grade}</div>`
  };
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a,b) => a-b);
  return s[Math.floor(s.length/2)];
}

function computeFinalScore() {
  const r = state.analysisResults;
  // PSA-style weighted: centering 35%, surface 25%, corners 20%, edges 20%
  const total = (r.centering.score * 0.35 + r.surface.score * 0.25 +
                 r.corners.score * 0.20 + r.edges.score * 0.20);
  const grade = total * 10;
  let label;
  if (grade >= 9.5) label = 'Gem Mint';
  else if (grade >= 9.0) label = 'Mint';
  else if (grade >= 8.0) label = 'Near Mint–Mint';
  else if (grade >= 7.0) label = 'Near Mint';
  else if (grade >= 6.0) label = 'Excellent';
  else label = 'Played';

  document.getElementById('gradeNumber').textContent = grade.toFixed(1);
  document.getElementById('gradeLabel').textContent = label;
  document.getElementById('finalScore').classList.add('show');
}

document.getElementById('toShowcase').addEventListener('click', () => {
  initShowcase();
  unlockScreen('showcase');
  showScreen('showcase');
});
