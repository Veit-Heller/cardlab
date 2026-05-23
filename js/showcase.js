// SCREEN 4: HOLO SHOWCASE
// 3D tilt + animated holographic foil effects driven by mouse / device gyro.
// The card is a flippable 3D object — front and back are separate textures.

const holoFlip = document.getElementById('holoFlip');
const holoCard = document.getElementById('holoCard');
const holoCardImgFront = document.getElementById('holoCardImgFront');
const holoCardImgBack = document.getElementById('holoCardImgBack');
const holoPattern = document.getElementById('holoPattern');
const holoSparkle = document.getElementById('holoSparkle');
const holoGlare = document.getElementById('holoGlare');
const holoRainbow = document.getElementById('holoRainbow');

let flipped = false;
let lastTilt = { mx: 0.5, my: 0.5 };

function initShowcase() {
  // Front: prefer the high-res frontCard captured by the new scan flow,
  // fall back to the legacy rectifiedCanvas (single-shot / demo path).
  const frontSrc = state.frontCard || state.rectifiedCanvas;
  if (frontSrc) {
    holoCardImgFront.style.backgroundImage = `url(${frontSrc.toDataURL('image/png')})`;
  }
  if (state.backCard) {
    holoCardImgBack.style.backgroundImage = `url(${state.backCard.toDataURL('image/png')})`;
  } else {
    // No back captured (demo / legacy flow) — show a subtle placeholder
    holoCardImgBack.style.background =
      'linear-gradient(135deg, #1a1a1a, #0a0a0a) center/cover no-repeat';
  }
  flipped = false;
  holoCard.style.setProperty('--flip', '0deg');
}

// Mouse / pointer tilt
function setTilt(mx, my, rect) {
  lastTilt.mx = mx; lastTilt.my = my;
  // mx, my in 0..1
  const rx = (0.5 - my) * 22; // rotateX
  const ry = (mx - 0.5) * 22; // rotateY
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.setProperty('--rx', rx + 'deg');
  holoCard.style.setProperty('--ry', ry + 'deg');
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  holoCard.style.transform = `rotateX(${rx}deg) rotateY(${ry + flipDeg}deg)`;

  // Move highlight position
  const mxPct = (mx * 100).toFixed(1) + '%';
  const myPct = (my * 100).toFixed(1) + '%';
  holoCard.style.setProperty('--mx', mxPct);
  holoCard.style.setProperty('--my', myPct);
  holoCard.style.setProperty('--bgx', (mx * 100).toFixed(1) + '%');
  holoCard.style.setProperty('--bgy', (my * 100).toFixed(1) + '%');

  // Glare angle
  const angle = (Math.atan2(my - 0.5, mx - 0.5) * 180 / Math.PI + 90 + 360) % 360;
  holoCard.style.setProperty('--angle', angle + 'deg');
  holoCard.style.setProperty('--ang2', (angle * 2) + 'deg');

  // Glare intensity proportional to distance from center
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
  // Reset transform but preserve flip state via CSS variable so the float
  // animation keeps the card oriented correctly.
  const flipDeg = flipped ? 180 : 0;
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
}

// Tap / click the card to flip it. The float animation keeps using --flip so
// the orientation stays right while idle.
function toggleFlip() {
  flipped = !flipped;
  const flipDeg = flipped ? 180 : 0;
  holoCard.classList.add('float'); // re-engage float so transition smooths
  holoCard.style.setProperty('--flip', flipDeg + 'deg');
  // Direct transform so the 0.5s ease transition kicks in even mid-tilt
  holoCard.style.transform = `rotateY(${flipDeg}deg)`;
  // Hide the hint after the first flip
  const hint = document.getElementById('holoFlipHint');
  if (hint) hint.style.opacity = '0';
}
holoFlip.addEventListener('click', toggleFlip);

document.getElementById('screen-showcase').addEventListener('mousemove', onPointerMove);
document.getElementById('screen-showcase').addEventListener('mouseleave', onPointerLeave);
holoCard.addEventListener('touchmove', onPointerMove, {passive: true});

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
    setTilt(x, y); // setTilt already folds flip into the transform
  });
}

// Holo style switching
document.querySelectorAll('.holo-style').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.holo-style').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyHoloStyle(btn.dataset.style);
  });
});

function applyHoloStyle(style) {
  // Adjust holo pattern bg + opacity
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
