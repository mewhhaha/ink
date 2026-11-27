// Detail-page controller: examples drawer, lazy source viewer and the
// Squid ABI 8 Wasm runner.

const TRAP_SITE_OFFSET = 772;
const DRAWER_MS = 280;

// ── Examples drawer ─────────────────────────────────────────────────────────
function initExamplesDrawer() {
  const trigger = document.getElementById('drawer-trigger');
  const drawer = document.getElementById('examples-drawer');
  if (!trigger || !drawer || typeof drawer.showModal !== 'function') return;
  const body = drawer.querySelector('.drawer-body');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let closeTimer = null;

  const links = () => Array.from(drawer.querySelectorAll('a[href]'));

  // The page behind a modal <dialog> is inert, so focus returns only after close().
  const finishClose = (restoreFocus = true) => {
    clearTimeout(closeTimer);
    closeTimer = null;
    drawer.removeEventListener('transitionend', onTransitionEnd);
    if (drawer.open) drawer.close();
    document.documentElement.classList.remove('drawer-locked');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };

  function onTransitionEnd(ev) {
    if (ev.target === drawer && ev.propertyName === 'transform') finishClose();
  }

  const open = () => {
    if (drawer.open) return;
    document.documentElement.classList.add('drawer-locked');
    trigger.setAttribute('aria-expanded', 'true');
    drawer.showModal();
    const current = drawer.querySelector('[aria-current="page"]');
    if (current && body) {
      const top = current.offsetTop - (body.clientHeight - current.offsetHeight) / 2;
      body.scrollTop = Math.max(0, top);
    }
    (current || drawer.querySelector('[data-drawer-close]'))?.focus({ preventScroll: true });
    // Commit the off-screen position before sliding in.
    void drawer.offsetWidth;
    drawer.classList.add('is-open');
  };

  const close = () => {
    if (!drawer.open || closeTimer !== null) return;
    drawer.classList.remove('is-open');
    if (reducedMotion.matches) {
      finishClose();
    } else {
      drawer.addEventListener('transitionend', onTransitionEnd);
      closeTimer = setTimeout(finishClose, DRAWER_MS + 80);
    }
  };

  trigger.addEventListener('click', open);
  for (const btn of drawer.querySelectorAll('[data-drawer-close]')) {
    btn.addEventListener('click', () => close());
  }
  // Clicks on the ::backdrop land on the <dialog> itself; the panel fills the box.
  drawer.addEventListener('click', (ev) => {
    if (ev.target === drawer) close();
  });
  // Animate Escape instead of the instant native close.
  drawer.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close();
  });
  // Keep keyboard events inside the open drawer from reaching Pen's window listener.
  drawer.addEventListener('keyup', (ev) => {
    ev.stopPropagation();
  });
  drawer.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    const items = links();
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    let next;
    if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    else if (ev.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
    else next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
    ev.preventDefault();
    items[next].focus();
  });
  // A page restored from the back/forward cache must not come back with the drawer open.
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted && drawer.open) {
      drawer.classList.remove('is-open');
      finishClose(false);
    }
  });
}

initExamplesDrawer();

// Share this module's cache-busting tag with the highlighter.
const { escapeHtml, highlightSquid } = await import(
  `./squid-highlight.js${new URL(import.meta.url).search}`
);

// ── On-demand source disclosure ─────────────────────────────────────────────
function initSourceDisclosures() {
  for (const details of document.querySelectorAll('details.source[data-src]')) {
    const codeEl = details.querySelector('code');
    const copyBtn = details.querySelector('[data-copy]');
    let loaded = false;
    let rawSource = '';

    const load = async () => {
      if (loaded) return;
      loaded = true;
      try {
        const resp = await fetch(details.dataset.src);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        rawSource = await resp.text();
        codeEl.innerHTML = highlightSquid(rawSource);
        if (copyBtn) copyBtn.disabled = false;
      } catch (err) {
        loaded = false;
        codeEl.textContent = `Could not load source: ${err.message || err}`;
      }
    };

    details.addEventListener('toggle', () => {
      if (details.open) load();
    });
    if (details.open) load();

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        if (!rawSource) return;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('unavailable');
          await navigator.clipboard.writeText(rawSource);
          copyBtn.textContent = 'Copied';
        } catch {
          copyBtn.textContent = 'Copy unavailable';
        }
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      });
    }
  }
}

// ── Squid ABI 8 Wasm runner ──────────────────────────────────────────────────
function formatF32(v) {
  if (!Number.isFinite(v)) return String(v);
  const rounded = Math.fround(v);
  const s = Math.abs(rounded) < 1e-6 && rounded !== 0
    ? rounded.toExponential(4)
    : String(Number(rounded.toPrecision(6)));
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

function readTrapTable(mod) {
  const sections = WebAssembly.Module.customSections(mod, 'squid:traps');
  if (!sections.length) return [];
  const bytes = new Uint8Array(sections[0]);
  if (bytes.length < 5 || bytes[0] !== 1) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(1, true);
  let off = 5;
  const dec = new TextDecoder('utf-8');
  const entries = [];
  for (let i = 0; i < count && off + 17 <= bytes.length; i++) {
    const k = bytes[off++];
    const kind = k === 1 ? 'panic' : k === 2 ? 'bounds' : 'unreachable';
    off += 12;
    const len = view.getUint32(off, true);
    off += 4;
    if (off + len > bytes.length) break;
    entries.push({ kind, message: dec.decode(bytes.subarray(off, off + len)) });
    off += len;
  }
  return entries;
}

function formatTrap(err, traps, mem) {
  if (mem && mem.buffer.byteLength >= TRAP_SITE_OFFSET + 4 && traps.length) {
    const id = new DataView(mem.buffer).getUint32(TRAP_SITE_OFFSET, true);
    if (id >= 1 && id <= traps.length) {
      const t = traps[id - 1];
      return t.message ? `${t.kind}: "${t.message}"` : t.kind;
    }
  }
  return err?.message ?? String(err);
}

function readSquidArray(mem, ptr, kind) {
  if (!mem) throw new Error('missing guest memory');
  if (ptr === 0 || (ptr & 3) !== 0) {
    throw new Error(`invalid array pointer (${ptr})`);
  }
  const byteLen = mem.buffer.byteLength;
  if (ptr > byteLen || byteLen - ptr < 4) {
    throw new Error(`array header out of bounds (${ptr})`);
  }
  const view = new DataView(mem.buffer);
  const len = view.getUint32(ptr, true);
  const payloadBytes = len * 4;
  if (len > 16_777_216 || ptr + 4 + payloadBytes > byteLen) {
    throw new Error(`array length out of bounds (${len})`);
  }
  if (kind === 'ArrayF32') {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = view.getFloat32(ptr + 4 + i * 4, true);
    return out;
  }
  const out = new Uint32Array(len);
  for (let i = 0; i < len; i++) out[i] = view.getUint32(ptr + 4 + i * 4, true);
  return out;
}

function parseInput(fnSpec, rawStr) {
  if (fnSpec.param === 'Unit') return { ok: true, value: 0, display: '' };
  const trimmed = String(rawStr).trim();
  if (!trimmed) return { ok: false, error: 'Enter a number.' };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { ok: false, error: 'Value must be finite.' };
  if (fnSpec.param === 'U32') {
    if (!Number.isInteger(num) || num < 0 || num > 0xFFFFFFFF) {
      return { ok: false, error: 'Expected an integer in 0..4294967295.' };
    }
    if (fnSpec.maxArg !== undefined && num > fnSpec.maxArg) {
      return { ok: false, error: `Expected an integer in 0..${fnSpec.maxArg}.` };
    }
    return { ok: true, value: num >>> 0, display: String(num) };
  }
  if (fnSpec.param === 'F32') {
    const f = Math.fround(num);
    if (!Number.isFinite(f)) return { ok: false, error: 'Value overflows F32.' };
    return { ok: true, value: f, display: trimmed };
  }
  return { ok: false, error: `Unsupported parameter type: ${fnSpec.param}` };
}

function initWasmRunner() {
  const specNode = document.getElementById('example-spec');
  if (!specNode) return;
  const spec = JSON.parse(specNode.textContent);
  const form = document.getElementById('runner-form');
  const fnField = document.getElementById('entry-field');
  const fnSelect = document.getElementById('entry-select');
  const argField = document.getElementById('arg-field');
  const argLabel = document.getElementById('arg-label');
  const argInput = document.getElementById('arg-input');
  const runBtn = document.getElementById('run-btn');
  const outEl = document.getElementById('runner-out');

  let compiledPromise = null;
  let latestRunId = 0;

  const loadModule = () => {
    if (!compiledPromise) {
      compiledPromise = (async () => {
        const resp = await fetch(spec.wasm);
        if (!resp.ok) throw new Error(`Could not fetch ${spec.wasm} (HTTP ${resp.status})`);
        const mod = await WebAssembly.compile(await resp.arrayBuffer());
        return { mod, traps: readTrapTable(mod) };
      })().catch((err) => {
        compiledPromise = null;
        throw err;
      });
    }
    return compiledPromise;
  };

  if (spec.entries.length > 1) {
    fnField.hidden = false;
    for (const fn of spec.entries) {
      const opt = new Option(`${fn.name}(${fn.param === 'Unit' ? '' : fn.param})`, fn.name);
      fnSelect.append(opt);
    }
  } else {
    fnField.hidden = true;
  }

  const currentFn = () =>
    spec.entries.find((f) => f.name === fnSelect.value) || spec.entries[0];

  const syncControls = () => {
    const fn = currentFn();
    const hasArg = fn.param !== 'Unit';
    argField.hidden = !hasArg;
    if (runBtn) runBtn.hidden = !hasArg;
    form.hidden = spec.entries.length <= 1 && !hasArg;
    if (hasArg) {
      argLabel.textContent = fn.paramLabel || fn.param;
      argInput.step = fn.param === 'F32' ? 'any' : '1';
      if (fn.param === 'U32') {
        argInput.min = '0';
        if (fn.maxArg !== undefined) argInput.max = String(fn.maxArg);
        else argInput.removeAttribute('max');
      } else {
        argInput.removeAttribute('min');
        argInput.removeAttribute('max');
      }
      argInput.value = String(fn.defaultArg);
    }
  };

  const runCurrent = async () => {
    const runId = ++latestRunId;
    const fn = currentFn();
    const parsed = parseInput(fn, argInput.value);
    if (!parsed.ok) {
      outEl.className = 'runner-out err';
      outEl.textContent = parsed.error;
      return;
    }
    const callHtml = fn.param === 'Unit'
      ? `<span class="tok-fn">${escapeHtml(fn.name)}</span> <span class="tok-punc">()</span>`
      : `<span class="tok-fn">${escapeHtml(fn.name)}</span> ${highlightSquid(parsed.display)}`;
    outEl.className = 'runner-out';
    outEl.innerHTML = `<span class="runner-time">Running</span> ${callHtml}<span class="runner-time">…</span>`;

    const t0 = performance.now();
    try {
      const { mod, traps } = await loadModule();
      if (runId !== latestRunId) return;
      const inst = await WebAssembly.instantiate(mod, {});
      const exp = inst.exports;
      const mem = exp['squid:memory'] || exp.memory;
      const reset = exp['squid:reset'];
      const enter = exp['squid:ownership_enter'];
      const leave = exp['squid:ownership_leave'];
      const finish = exp['squid:finish_invocation'];

      if (typeof reset === 'function') reset(0);
      if (typeof enter === 'function') enter();

      let outcome = 1;
      let formatted = '()';
      let runErr = null;
      try {
        const raw = exp[fn.name](parsed.value);
        if (fn.result === 'F32') formatted = formatF32(raw);
        else if (fn.result === 'U32') formatted = String(raw >>> 0);
        else if (fn.result === 'Bool') formatted = raw ? 'true' : 'false';
        else if (fn.result === 'ArrayF32') {
          const vals = readSquidArray(mem, raw >>> 0, 'ArrayF32');
          formatted = `#[${Array.from(vals).map(formatF32).join(', ')}]`;
        } else if (fn.result === 'ArrayU32') {
          const vals = readSquidArray(mem, raw >>> 0, 'ArrayU32');
          formatted = `#[${Array.from(vals).join(', ')}]`;
        }
        outcome = 0;
      } catch (err) {
        runErr = formatTrap(err, traps, mem);
      }

      let cleanupErr = null;
      try {
        if (typeof leave === 'function') leave(outcome);
        if (typeof finish === 'function') finish();
      } catch (err) {
        cleanupErr = err?.message ?? String(err);
      }

      if (runId !== latestRunId) return;
      const elapsed = (performance.now() - t0).toFixed(2);
      if (runErr) {
        outEl.className = 'runner-out err';
        outEl.innerHTML = `${callHtml}\ntrap: ${escapeHtml(runErr)} <span class="runner-time">(${elapsed} ms)</span>`;
      } else if (cleanupErr) {
        outEl.className = 'runner-out err';
        outEl.innerHTML = `${callHtml}\ncleanup error: ${escapeHtml(cleanupErr)}`;
      } else {
        outEl.className = 'runner-out';
        outEl.innerHTML = `${callHtml}\n<span class="tok-op">=&gt;</span> ${highlightSquid(formatted)}\n<span class="runner-time">(${elapsed} ms)</span>`;
      }
    } catch (err) {
      if (runId !== latestRunId) return;
      outEl.className = 'runner-out err';
      outEl.textContent = err?.message ?? String(err);
    }
  };

  syncControls();
  fnSelect.addEventListener('change', () => {
    syncControls();
    runCurrent();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    runCurrent();
  });
  runCurrent();
}

initSourceDisclosures();
initWasmRunner();
