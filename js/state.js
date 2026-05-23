// Global app state + screen navigation.
// Shared across all screen modules (scan, crop, analysis, showcase).

const state = {
  // Legacy single-frame fields (still used by crop screen + analysis)
  sourceImage: null,
  corners: null,
  rectifiedCanvas: null,    // alias for frontCard, kept for back-compat with analysis.js

  // New: full card digitisation. Both are 1500×2100 canvases of the rectified card
  // with background removed (only the card's own pixels). Set by scan.js after the
  // Front+Back capture flow.
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
