// Detail-page controller: lazy source viewer + Blot ABI 8 Wasm runner.
import { escapeHtml, highlightBlot } from './blot-highlight.js';

const TRAP_SITE_OFFSET = 772;

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
        codeEl.innerHTML = highlightBlot(rawSource);
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

// ── Blot ABI 8 Wasm runner ──────────────────────────────────────────────────
function formatF32(v) {
  if (!Number.isFinite(v)) return String(v);
  const rounded = Math.fround(v);
  const s = Math.abs(rounded) < 1e-6 && rounded !== 0
    ? rounded.toExponential(4)
    : String(Number(rounded.toPrecision(6)));
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

function readTrapTable(mod) {
  const sections = WebAssembly.Module.customSections(mod, 'blot:traps');
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

function readBlotArray(mem, ptr, kind) {
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
      : `<span class="tok-fn">${escapeHtml(fn.name)}</span> ${highlightBlot(parsed.display)}`;
    outEl.className = 'runner-out';
    outEl.innerHTML = `<span class="runner-time">Running</span> ${callHtml}<span class="runner-time">…</span>`;

    const t0 = performance.now();
    try {
      const { mod, traps } = await loadModule();
      if (runId !== latestRunId) return;
      const inst = await WebAssembly.instantiate(mod, {});
      const exp = inst.exports;
      const mem = exp['blot:memory'] || exp.memory;
      const reset = exp['blot:reset'];
      const enter = exp['blot:ownership_enter'];
      const leave = exp['blot:ownership_leave'];
      const finish = exp['blot:finish_invocation'];

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
          const vals = readBlotArray(mem, raw >>> 0, 'ArrayF32');
          formatted = `#[${Array.from(vals).map(formatF32).join(', ')}]`;
        } else if (fn.result === 'ArrayU32') {
          const vals = readBlotArray(mem, raw >>> 0, 'ArrayU32');
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
        outEl.innerHTML = `${callHtml}\n<span class="tok-op">=&gt;</span> ${highlightBlot(formatted)}\n<span class="runner-time">(${elapsed} ms)</span>`;
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
