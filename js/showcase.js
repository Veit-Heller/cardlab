// SCREEN 4: HOLO SHOWCASE
// Two textures (front + back), 3D-flippable card, CSS-pseudo-holo overlay
// that responds to mouse / gyro tilt.

const holoFlip = document.getElementById('holoFlip');
const holoCard = document.getElementById('holoCard');
const holoCardImgFront = document.getElementById('holoCardImgFront');
const holoCardImgBack = document.getElementById('holoCardImgBack');
const holoPattern = document.getElementById('holoPattern');
const holoSparkle = document.getElementById('holoSparkle');
const holoGlare = document.getElementById('holoGlare');
const holoRainbow = document.getElementById('holoRainbow');

let flipped = false;

function initShowcase() {
  flipped = false;
  holoCard.style.setProperty('--flip', '0deg');

  const frontSrc = state.frontCard || state.rectifiedCanvas;
  if (frontSrc) {
    holoCardImgFront.style.backgroundImage = `url(${frontSrc.toDataURL('image/png')})`;
  }
  if (state.backCard) {
    holoCardImgBack.style.backgroundImage = `url(${state.backCard.toDataURL('image/png')})`;
  } else {
    holoCardImgBack.style.background =
      'linear-gradient(135deg, #1a1a1a, #0a0a0a) center/cover no-repeat';
  }

  // Holo overlay layers OFF by default — they overlay the actual scan and the
  // user wants to see the real card. User can enable an effect via the style
  // buttons below the card.
  [holoPattern, holoRainbow, holoSparkle, holoGlare].forEach(el => {
    el.style.display = 'none';
  });
  document.querySelectorAll('.holo-style').forEach(b => b.classList.remove('active'));
}

// Mouse / pointer tilt
function setTilt(mx, my) {
  // mx, my in 0..1
  const rx = (0.5 - my) * 22;
  const ry = (mx - 0.5) * 22;
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.setProperty('--rx', rx + 'deg');
  holoCard.style.setProperty('--ry', ry + 'deg');
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  holoCard.style.transform = `rotateX(${rx}deg) rotateY(${ry + flipDeg}deg)`;

  // Holo shimmer position + angle
  holoCard.style.setProperty('--mx', (mx * 100).toFixed(1) + '%');
  holoCard.style.setProperty('--my', (my * 100).toFixed(1) + '%');
  holoCard.style.setProperty('--bgx', (mx * 100).toFixed(1) + '%');
  holoCard.style.setProperty('--bgy', (my * 100).toFixed(1) + '%');
  const angle = (Math.atan2(my - 0.5, mx - 0.5) * 180 / Math.PI + 90 + 360) % 360;
  holoCard.style.setProperty('--angle', angle + 'deg');
  holoCard.style.setProperty('--ang2', (angle * 2) + 'deg');
  const dist = Math.hypot(mx-0.5, my-0.5) * 2;
  holoCard.style.setProperty('--shine', (0.4 + dist * 0.5).toFixed(2));
  holoCard.style.setProperty('--glare', (0.3 + dist * 0.5).toFixed(2));
}

function onPointerMove(e) {
  const rect = holoCard.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  const x = (t.clientX - rect.left) / rect.width;
  const y = (t.clientY - rect.top) / rect.height;
  if (x < -0.3 || x > 1.3 || y < -0.3 || y > 1.3) return;
  holoCard.classList.remove('float');
  setTilt(Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)));
}
function onPointerLeave() {
  holoCard.classList.add('float');
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
}

function toggleFlip() {
  flipped = !flipped;
  const flipDeg = flipped ? 180 : 0;
  holoCard.classList.add('float');
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
  const hint = document.getElementById('holoFlipHint');
  if (hint) hint.style.opacity = '0';
}
holoFlip.addEventListener('click', toggleFlip);

document.getElementById('screen-showcase').addEventListener('mousemove', onPointerMove);
document.getElementById('screen-showcase').addEventListener('mouseleave', onPointerLeave);
holoCard.addEventListener('touchmove', onPointerMove, { passive: true });

// Gyroscope
document.getElementById('enableGyro').addEventListener('click', async () => {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') startGyro();
    } catch(e) {}
  } else {
    startGyro();
  }
});

function startGyro() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta === null || e.gamma === null) return;
    holoCard.classList.remove('float');
    const x = Math.max(0, Math.min(1, 0.5 + (e.gamma / 60)));
    const y = Math.max(0, Math.min(1, 0.5 + ((e.beta - 30) / 60)));
    setTilt(x, y);
  });
}

// Holo style switching — click a style to turn on the overlay; click the same
// active style again to turn it off (so "no overlay" is reachable from the UI).
document.querySelectorAll('.holo-style').forEach(btn => {
  btn.addEventListener('click', () => {
    const wasActive = btn.classList.contains('active');
    document.querySelectorAll('.holo-style').forEach(b => b.classList.remove('active'));
    if (wasActive) {
      // toggle off: hide all overlay layers
      [holoPattern, holoRainbow, holoSparkle, holoGlare].forEach(el => el.style.display = 'none');
    } else {
      [holoPattern, holoRainbow, holoSparkle, holoGlare].forEach(el => el.style.display = '');
      btn.classList.add('active');
      applyHoloStyle(btn.dataset.style);
    }
  });
});

// PNG download — let the user grab the digitised card as a file
function downloadCardPng(canvas, filename) {
  if (!canvas) return;
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const dlFrontBtn = document.getElementById('btnDownloadFront');
const dlBackBtn = document.getElementById('btnDownloadBack');
if (dlFrontBtn) dlFrontBtn.addEventListener('click', () => {
  downloadCardPng(state.frontCard || state.rectifiedCanvas, 'cardlab-front.png');
});
if (dlBackBtn) dlBackBtn.addEventListener('click', () => {
  downloadCardPng(state.backCard, 'cardlab-back.png');
});

function applyHoloStyle(style) {
  switch(style) {
    case 'cosmos':
      holoPattern.style.background =
        `repeating-linear-gradient(115deg,
          rgba(255,0,128,0.0) 0%, rgba(255,0,128,0.4) 5%,
          rgba(255,200,0,0.4) 10%, rgba(0,255,200,0.4) 15%,
          rgba(50,100,255,0.4) 20%, rgba(255,0,128,0.0) 25%)`;
      holoPattern.style.opacity = '0.6';
      holoRainbow.style.opacity = '0.4';
      break;
    case 'rainbow':
      holoPattern.style.background =
        `repeating-linear-gradient(90deg,
          rgba(255,0,0,0.5) 0%, rgba(255,165,0,0.5) 14%,
          rgba(255,255,0,0.5) 28%, rgba(0,255,0,0.5) 42%,
          rgba(0,127,255,0.5) 56%, rgba(127,0,255,0.5) 70%,
          rgba(255,0,0,0.5) 100%)`;
      holoPattern.style.opacity = '0.75';
      holoRainbow.style.opacity = '0.55';
      break;
    case 'gold':
      holoPattern.style.background =
        `repeating-linear-gradient(105deg,
          rgba(212,175,106,0.0) 0%, rgba(240,204,127,0.6) 6%,
          rgba(255,235,160,0.6) 12%, rgba(212,175,106,0.4) 18%,
          rgba(180,140,60,0.4) 24%, rgba(212,175,106,0.0) 30%)`;
      holoPattern.style.opacity = '0.7';
      holoRainbow.style.opacity = '0.2';
      break;
    case 'subtle':
      holoPattern.style.background =
        `linear-gradient(120deg,
          rgba(255,255,255,0.0) 30%, rgba(255,255,255,0.3) 50%,
          rgba(255,255,255,0.0) 70%)`;
      holoPattern.style.opacity = '0.35';
      holoRainbow.style.opacity = '0.1';
      break;
  }
}
