// Global app state + screen navigation.
// Shared across all screen modules (scan, crop, analysis, showcase).

const state = {
  // Legacy single-frame fields (still used by crop screen + analysis)
  sourceImage: null,
  corners: null,
  rectifiedCanvas: null,    // alias for frontCard, kept for back-compat with analysis.js

  // Full card digitisation: per-side multi-view frames keyed by tilt pose.
  // Each entry is a 1500×2100 canvas of the rectified card with background
  // removed. The same pixel coordinates align across all 5 frames per side,
  // so the showcase can sample them as a tilt-dependent texture stack.
  frontFrames: null,        // { center, left, right, up, down } | null
  backFrames:  null,
  // Convenience aliases (= the .center frame) for analysis + back-compat.
  frontCard: null,
  backCard: null,

  analysisResults: null,
  currentScreen: 'capture',
};

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === name);
  });
  state.currentScreen = name;
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function unlockScreen(name) {
  document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.dataset.screen === name) b.disabled = false;
  });
}

document.querySelectorAll('.nav-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (!b.disabled) showScreen(b.dataset.screen);
  });
});
