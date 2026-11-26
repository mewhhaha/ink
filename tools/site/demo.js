// Top-level Pen WebGPU demo launcher (no iframe).
// Scopes the optional COOP/COEP fallback worker strictly to `demos/` and keeps
// Pen's runtime error slot (`#status`) separate from startup loading state.

const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');
const stageEl = document.getElementById('stage');
const canvasEl = document.getElementById('game');
const restartBtn = document.getElementById('restart-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');

const ROOT_SW_URL = new URL('./service-worker.js', import.meta.url).href;
const DEMOS_SW_URL = new URL('./demos/service-worker.js', import.meta.url).href;
const DEMOS_SW_SCOPE = new URL('./demos/', import.meta.url).href;
const RUNTIME_VERSION = new URL(import.meta.url).searchParams.get('v') || '';

let startupTimer = null;
let fatalReason = null;
let adapterSummary = '';
const diagLines = [];

function recordDiagnostic(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.includes('Failed to load resource: the server responded with a status of 404')) {
    return;
  }
  const clipped = clean.length > 360 ? `${clean.slice(0, 357)}…` : clean;
  if (diagLines.length < 6 && !diagLines.includes(clipped)) {
    diagLines.push(clipped);
    if (fatalReason !== null) {
      statusEl.textContent = formatFatalError(fatalReason);
    }
  }
}

const origConsoleError = console.error.bind(console);
console.error = (...args) => {
  origConsoleError(...args);
  const text = args
    .map((a) => (typeof a === 'string' ? a : a?.stack || a?.message || String(a)))
    .join(' ');
  recordDiagnostic(text);
};

function clearStartupTimer() {
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function setLoading(text) {
  loadingEl.textContent = text;
  loadingEl.hidden = !text;
}

function setError(text, reason = null) {
  clearStartupTimer();
  setLoading('');
  if (reason !== null) {
    fatalReason = reason;
  }
  statusEl.textContent = text;
}

function formatFatalError(reason) {
  const detail = reason?.message ? String(reason.message) : String(reason || 'Unexpected runtime failure');
  const lines = [`WebGPU demo failed: ${detail}`];
  if (diagLines.length) {
    lines.push('', ...diagLines);
  }
  if (adapterSummary) {
    lines.push('', adapterSummary);
  }
  lines.push('', 'Press Restart or try a hardware WebGPU adapter.');
  return lines.join('\n');
}

window.addEventListener('error', (ev) => {
  if (!statusEl.textContent.trim()) {
    const reason = ev.error || ev.message;
    setError(formatFatalError(reason), reason);
  }
});

window.addEventListener('unhandledrejection', (ev) => {
  if (!statusEl.textContent.trim()) {
    setError(formatFatalError(ev.reason), ev.reason);
  }
});

async function retireLegacyRootWorkers() {
  if (!('serviceWorker' in navigator)) return false;
  const regs = await navigator.serviceWorker.getRegistrations();
  let retired = false;
  for (const reg of regs) {
    const url = reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || '';
    if (url === ROOT_SW_URL && url !== DEMOS_SW_URL) {
      await reg.unregister();
      retired = true;
    }
  }
  return retired;
}

async function waitForScopedWorker(reg) {
  if (navigator.serviceWorker.controller?.scriptURL === DEMOS_SW_URL) return true;
  const activeWorker = reg.active?.scriptURL === DEMOS_SW_URL ? reg.active : null;
  if (activeWorker && activeWorker.state === 'activated') return true;
  await Promise.race([
    new Promise((resolve) => {
      const check = () => {
        if (navigator.serviceWorker.controller?.scriptURL === DEMOS_SW_URL) {
          navigator.serviceWorker.removeEventListener('controllerchange', check);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', check);
      const pending = reg.installing || reg.waiting;
      if (pending) {
        pending.addEventListener('statechange', () => {
          if (pending.state === 'activated' || pending.state === 'redundant') resolve();
        });
      }
      check();
    }),
    new Promise((resolve) => setTimeout(resolve, 3500)),
  ]);
  return (
    navigator.serviceWorker.controller?.scriptURL === DEMOS_SW_URL ||
    reg.active?.scriptURL === DEMOS_SW_URL
  );
}

async function ensureJspiOrIsolation() {
  const hasJspi = Boolean(WebAssembly.Suspending && WebAssembly.promising);
  const key = `ink.iso:${location.pathname}`;

  if (hasJspi) {
    sessionStorage.removeItem(key);
    retireLegacyRootWorkers().catch(() => {});
    return true;
  }

  const ctrl = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  const controlledByLegacy = Boolean(ctrl && ctrl.scriptURL !== DEMOS_SW_URL);

  if (crossOriginIsolated && !controlledByLegacy) {
    sessionStorage.removeItem(key);
    retireLegacyRootWorkers().catch(() => {});
    return true;
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error(
      'This browser needs WebAssembly JSPI (Chrome 137+, Firefox 153+, Safari 27+) or a cross-origin isolated page.'
    );
  }

  await retireLegacyRootWorkers();
  const reg = await navigator.serviceWorker.register(DEMOS_SW_URL, { scope: DEMOS_SW_SCOPE });
  const scopedReady = await waitForScopedWorker(reg);

  if (scopedReady && !sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, '1');
    location.reload();
    await new Promise(() => {});
  }
  sessionStorage.removeItem(key);

  if (!crossOriginIsolated) {
    throw new Error(
      'Cross-origin isolation did not activate. Reload once or use a browser with WebAssembly JSPI.'
    );
  }
  return true;
}

if (restartBtn) {
  restartBtn.addEventListener('click', () => location.reload());
}
if (fullscreenBtn) {
  if (!stageEl.requestFullscreen) {
    fullscreenBtn.hidden = true;
  } else {
    fullscreenBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await stageEl.requestFullscreen();
      } catch (err) {
        setError(`Fullscreen unavailable: ${err?.message ?? err}`);
      }
    });
  }
}

canvasEl.addEventListener('pointerdown', () => {
  canvasEl.focus({ preventScroll: true });
});

async function bootDemo() {
  statusEl.textContent = '';
  setLoading('Loading WebGPU runtime…');
  if (!('gpu' in navigator)) {
    setError(
      'WebGPU is not available in this browser.\nUse Chrome/Edge 113+, Firefox 141+, or Safari 26+.'
    );
    return;
  }
  await ensureJspiOrIsolation();
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      const info = adapter.info || {};
      const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
      const fallback = info.isFallbackAdapter ? ' fallback' : '';
      const lim = adapter.limits || {};
      adapterSummary = `Adapter: ${parts.join(' / ') || 'unknown'}${fallback} (storage=${lim.maxStorageBuffersPerShaderStage ?? '?'}, tex2d=${lim.maxTextureDimension2D ?? '?'}, ver=${RUNTIME_VERSION || 'dev'})`;
    }
  } catch {
    // Diagnostic probe only; Pen requests its own adapter below.
  }
  const suffix = RUNTIME_VERSION ? `?v=${encodeURIComponent(RUNTIME_VERSION)}` : '';
  const penModuleUrl = new URL(`./demos/pen/pen_web.js${suffix}`, import.meta.url).href;
  const penWasmUrl = new URL(`./demos/pen/pen_web_bg.wasm${suffix}`, import.meta.url);
  const { default: init, start } = await import(penModuleUrl);
  await init({ module_or_path: penWasmUrl });

  const markReady = () => {
    clearStartupTimer();
    setLoading('');
    observer.disconnect();
  };

  const observer = new MutationObserver(() => {
    if (canvasEl.dataset.ready === 'true') {
      markReady();
    }
  });
  observer.observe(canvasEl, { attributes: true, attributeFilter: ['data-ready'] });

  const statusObserver = new MutationObserver(() => {
    if (statusEl.textContent.trim()) {
      clearStartupTimer();
      setLoading('');
    }
  });
  statusObserver.observe(statusEl, { childList: true, characterData: true, subtree: true });

  startupTimer = setTimeout(() => {
    if (canvasEl.dataset.ready !== 'true' && !statusEl.textContent.trim()) {
      setError(
        'WebGPU demo timed out waiting for the first frame.\nYour GPU adapter or browser driver may not support this demo. Press Restart to retry.'
      );
    }
  }, 15000);

  await start(canvasEl, {
    game: './game.wasm',
    catalog: './catalog.json',
    manifest: './game.json',
    assets: './assets',
    development: false,
    qualify: false,
  });
  if (canvasEl.dataset.ready === 'true') {
    markReady();
  }
}

bootDemo().catch((err) => {
  setError(formatFatalError(err), err);
});
