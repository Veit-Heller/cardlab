// Global app state + screen navigation.
// Shared across all screen modules (scan, crop, analysis, showcase).

const state = {
  sourceImage: null,      // Original uploaded image
  corners: null,          // 4 corner points {x,y} normalized to canvas
  rectifiedCanvas: null,  // Perspective-corrected card canvas
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
