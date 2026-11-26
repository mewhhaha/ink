// Ink interactive examples gallery + Blot ABI 8 browser Wasm runner.

const GITHUB_BASE = 'https://github.com/mewhhaha/ink/blob/main/';
const TRAP_SITE_OFFSET = 4;

// Register root service worker so browsers without WebAssembly JSPI get
// COOP/COEP cross-origin isolation on static hosts like GitHub Pages.
async function registerIsolationWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
    const hasJspi = Boolean(WebAssembly.Suspending && WebAssembly.promising);
    if (!hasJspi && !crossOriginIsolated) {
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
          new Promise(r => setTimeout(r, 2500)),
        ]);
      }
      if (navigator.serviceWorker.controller && !sessionStorage.getItem('ink.isolated')) {
        sessionStorage.setItem('ink.isolated', '1');
        location.reload();
      }
    }
  } catch (err) {
    console.warn('service-worker registration skipped:', err);
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const KEYWORDS = new Set([
  'import', 'as', 'from', 'type', 'is', 'data', 'trait', 'effect', 'opaque', 'impl', 'where',
  'func', 'io', 'private', 'const', 'let', 'own', 'self', 'if', 'then', 'else', 'for', 'in',
  'case', 'of', 'return', 'break', 'continue', 'do', 'use', 'with', 'test', 'expect_trap',
  'and', 'or', 'not', 'true', 'false', 'panic', 'copy', 'freeze',
]);

function highlightBlot(source) {
  const tokenRe = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|@[A-Za-z_][A-Za-z0-9_.]*|\$[A-Za-z_][A-Za-z0-9_.]*|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let out = '';
  let last = 0;
  for (const m of source.matchAll(tokenRe)) {
    const idx = m.index;
    if (idx > last) out += escapeHtml(source.slice(last, idx));
    const tok = m[0];
    let cls = '';
    if (tok.startsWith('//')) cls = 'tok-com';
    else if (tok.startsWith('"')) cls = 'tok-str';
    else if (tok.startsWith('@')) cls = 'tok-int';
    else if (tok.startsWith('$')) cls = 'tok-con';
    else if (/^\d/.test(tok)) cls = 'tok-num';
    else if (KEYWORDS.has(tok)) cls = 'tok-kw';
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    last = idx + tok.length;
  }
  if (last < source.length) out += escapeHtml(source.slice(last));
  return out;
}

function formatF32(v) {
  if (!Number.isFinite(v)) return String(v);
  const rounded = Math.fround(v);
  const s = Math.abs(rounded) < 1e-6 && rounded !== 0 ? rounded.toExponential(4) : String(Number(rounded.toPrecision(6)));
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
    const msg = dec.decode(bytes.subarray(off, off + len));
    off += len;
    entries.push({ kind, message: msg });
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
  const view = new DataView(mem.buffer);
  const len = view.getUint32(ptr, true);
  if (kind === 'ArrayF32') {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = view.getFloat32(ptr + 4 + i * 4, true);
    return out;
  }
  const out = new Uint32Array(len);
  for (let i = 0; i < len; i++) out[i] = view.getUint32(ptr + 4 + i * 4, true);
  return out;
}

const wasmCache = new Map();

async function loadWasmModule(url) {
  if (wasmCache.has(url)) return wasmCache.get(url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  const bytes = await resp.arrayBuffer();
  const mod = await WebAssembly.compile(bytes);
  const entry = { mod, traps: readTrapTable(mod) };
  wasmCache.set(url, entry);
  return entry;
}

async function runWasmEntry(wasmUrl, fnSpec, rawArg) {
  const t0 = performance.now();
  const { mod, traps } = await loadWasmModule(wasmUrl);
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
  try {
    let raw;
    if (fnSpec.param === 'Unit') raw = exp[fnSpec.name]();
    else if (fnSpec.param === 'F32') raw = exp[fnSpec.name](Math.fround(Number(rawArg)));
    else if (fnSpec.param === 'U32') raw = exp[fnSpec.name]((Number(rawArg) >>> 0));
    else throw new Error(`Unsupported parameter type: ${fnSpec.param}`);
    outcome = 0;
    let formatted = '()';
    if (fnSpec.result === 'F32') formatted = formatF32(raw);
    else if (fnSpec.result === 'U32') formatted = String(raw >>> 0);
    else if (fnSpec.result === 'Bool') formatted = raw ? 'true' : 'false';
    else if (fnSpec.result === 'ArrayF32') {
      const vals = readBlotArray(mem, raw >>> 0, 'ArrayF32');
      formatted = `#[${Array.from(vals).map(formatF32).join(', ')}]`;
    } else if (fnSpec.result === 'ArrayU32') {
      const vals = readBlotArray(mem, raw >>> 0, 'ArrayU32');
      formatted = `#[${Array.from(vals).join(', ')}]`;
    }
    const elapsedMs = performance.now() - t0;
    return { ok: true, formatted, elapsedMs };
  } catch (err) {
    return { ok: false, formatted: `trap: ${formatTrap(err, traps, mem)}`, elapsedMs: performance.now() - t0 };
  } finally {
    try {
      if (typeof leave === 'function') leave(outcome);
      if (typeof finish === 'function') finish();
    } catch (_) { /* ignore cleanup error after trap */ }
  }
}

// ── UI State ────────────────────────────────────────────────────────────────
let manifest = null;
let activeCategory = 'All';
let searchQuery = '';
let activeSlug = null;

const sidebarEl = document.getElementById('sidebar');
const menuToggle = document.getElementById('menu-toggle');
const searchInput = document.getElementById('search-input');
const categoryTabs = document.getElementById('category-tabs');
const exampleList = document.getElementById('example-list');
const statsLabel = document.getElementById('stats-label');
const stageEl = document.getElementById('stage');
const docsLink = document.getElementById('docs-link');

menuToggle.addEventListener('click', () => {
  const open = sidebarEl.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  renderList();
});

function filteredExamples() {
  return manifest.examples.filter(ex => {
    if (activeCategory !== 'All' && ex.category !== activeCategory) return false;
    if (!searchQuery) return true;
    const hay = [ex.title, ex.slug, ex.summary, ex.category, ...(ex.modules || [])].join(' ').toLowerCase();
    return hay.includes(searchQuery);
  });
}

function renderCategories() {
  const cats = ['All', ...new Set(manifest.examples.map(e => e.category))];
  categoryTabs.innerHTML = '';
  for (const cat of cats) {
    const btn = document.createElement('button');
    btn.className = `cat-btn${cat === activeCategory ? ' active' : ''}`;
    btn.textContent = cat;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(cat === activeCategory));
    btn.addEventListener('click', () => {
      activeCategory = cat;
      renderCategories();
      renderList();
    });
    categoryTabs.appendChild(btn);
  }
}

function renderList() {
  const items = filteredExamples();
  exampleList.innerHTML = '';
  const penItems = items.filter(e => e.kind === 'pen');
  const wasmItems = items.filter(e => e.kind !== 'pen');

  const appendGroup = (label, group) => {
    if (!group.length) return;
    const heading = document.createElement('div');
    heading.className = 'list-section';
    heading.textContent = label;
    exampleList.appendChild(heading);
    for (const ex of group) {
      const btn = document.createElement('button');
      btn.className = `example-item${ex.slug === activeSlug ? ' active' : ''}`;
      btn.innerHTML = `
        <div class="item-top">
          <span class="item-title">${escapeHtml(ex.title)}</span>
          <span class="badge ${ex.kind === 'pen' ? 'badge-pen' : 'badge-wasm'}">${ex.kind === 'pen' ? 'WebGPU' : 'Wasm'}</span>
        </div>
        <div class="item-desc">${escapeHtml(ex.summary)}</div>
      `;
      btn.addEventListener('click', () => {
        selectExample(ex.slug);
        sidebarEl.classList.remove('open');
      });
      exampleList.appendChild(btn);
    }
  };

  appendGroup('Interactive Pen Demos (WebGPU)', penItems);
  appendGroup('Standalone Blot Examples (Wasm)', wasmItems);

  if (!items.length) {
    exampleList.innerHTML = '<div class="list-section">No matching examples</div>';
  }
}

function renderSourceCard(ex, collapsed) {
  const wrap = document.createElement('section');
  wrap.className = 'source-card';
  wrap.innerHTML = `
    <div class="source-header">
      <span>${escapeHtml(ex.file)}</span>
      <div class="action-bar">
        <button class="btn" data-copy>Copy</button>
        <a class="btn" href="${GITHUB_BASE}${encodeURI(ex.file)}" target="_blank" rel="noopener">GitHub ↗</a>
      </div>
    </div>
    <pre class="source-code" ${collapsed ? 'hidden' : ''}><code>${highlightBlot(ex.source)}</code></pre>
  `;
  const copyBtn = wrap.querySelector('[data-copy]');
  copyBtn.addEventListener('click', async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(ex.source);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  });
  return wrap;
}

function renderExample(ex) {
  stageEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'hero-header';
  const chips = (ex.modules || []).map(m => `<span class="module-chip">${escapeHtml(m)}</span>`).join('');
  header.innerHTML = `
    <div>
      <h1 class="hero-title">
        ${escapeHtml(ex.title)}
        <span class="badge ${ex.kind === 'pen' ? 'badge-pen' : 'badge-wasm'}">${ex.kind === 'pen' ? 'Interactive Pen WebGPU' : 'Pure Blot Wasm'}</span>
      </h1>
      <p class="hero-summary">${escapeHtml(ex.summary)}</p>
      <div class="chip-row">${chips}</div>
    </div>
    <div class="action-bar" id="hero-actions"></div>
  `;
  stageEl.appendChild(header);
  const actionsEl = header.querySelector('#hero-actions');

  if (ex.kind === 'pen') {
    const demoUrl = `./demos/${encodeURIComponent(ex.slug)}/index.html`;
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn';
    reloadBtn.textContent = '↻ Restart Demo';
    const openLink = document.createElement('a');
    openLink.className = 'btn btn-primary';
    openLink.href = demoUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.textContent = 'Open Fullscreen ↗';
    actionsEl.append(reloadBtn, openLink);

    const card = document.createElement('section');
    card.className = 'demo-card';
    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    if (!hasWebGpu) {
      const warn = document.createElement('div');
      warn.className = 'webgpu-banner';
      warn.textContent = 'WebGPU was not detected in this browser. Live Pen demos require a WebGPU-enabled browser (Chrome/Edge 113+, Firefox 141+, or Safari 26+); pure Blot Wasm examples and source code still work everywhere.';
      card.appendChild(warn);
    }
    const hint = document.createElement('div');
    hint.className = 'demo-hint';
    hint.innerHTML = `<span>${escapeHtml(ex.controls || 'Interactive WebGPU canvas powered by Pen')}</span><span style="font-family:var(--font-mono);font-size:12px;">pen build --web</span>`;
    card.appendChild(hint);

    const frameWrap = document.createElement('div');
    frameWrap.className = 'demo-frame-wrap';
    const iframe = document.createElement('iframe');
    iframe.className = 'demo-frame';
    iframe.title = ex.title;
    iframe.src = demoUrl;
    iframe.allow = 'autoplay; fullscreen';
    frameWrap.appendChild(iframe);
    card.appendChild(frameWrap);
    stageEl.appendChild(card);

    reloadBtn.addEventListener('click', () => {
      iframe.src = `${demoUrl}?r=${Date.now()}`;
    });

    stageEl.appendChild(renderSourceCard(ex, false));
  } else {
    if (ex.wasm && ex.entries && ex.entries.length) {
      const runner = document.createElement('section');
      runner.className = 'runner-card';
      const controls = document.createElement('div');
      controls.className = 'runner-controls';

      const fnLabel = document.createElement('label');
      fnLabel.textContent = 'Entry:';
      const fnSelect = document.createElement('select');
      for (const fn of ex.entries) {
        const opt = document.createElement('option');
        opt.value = fn.name;
        opt.textContent = `${fn.name}(${fn.param === 'Unit' ? '' : fn.param}) : ${fn.result}`;
        fnSelect.appendChild(opt);
      }
      fnLabel.appendChild(fnSelect);

      const argLabel = document.createElement('label');
      const argName = document.createElement('span');
      const argInput = document.createElement('input');
      argInput.type = 'number';
      argInput.style.width = '110px';
      argLabel.append(argName, argInput);

      const runBtn = document.createElement('button');
      runBtn.className = 'btn btn-primary';
      runBtn.textContent = '▶ Run in Browser (Wasm)';

      controls.append(fnLabel, argLabel, runBtn);
      const output = document.createElement('pre');
      output.className = 'runner-output';
      output.textContent = 'Running…';

      const currentFn = () => ex.entries.find(f => f.name === fnSelect.value) || ex.entries[0];
      const syncArgInput = () => {
        const fn = currentFn();
        if (fn.param === 'Unit') {
          argLabel.hidden = true;
        } else {
          argLabel.hidden = false;
          argName.textContent = `${fn.paramLabel || 'arg'} (${fn.param}):`;
          argInput.step = fn.param === 'F32' ? '0.1' : '1';
          argInput.value = String(fn.defaultArg ?? (fn.param === 'F32' ? 0.5 : 10));
        }
      };

      const execute = async () => {
        const fn = currentFn();
        output.className = 'runner-output';
        output.textContent = `Running ${fn.name}…`;
        const res = await runWasmEntry(`./${ex.wasm}`, fn, argInput.value);
        output.className = `runner-output${res.ok ? '' : ' err'}`;
        const callText = fn.param === 'Unit' ? `${fn.name} ()` : `${fn.name} ${argInput.value}`;
        output.textContent = `${callText}\n=> ${res.formatted}\n(${res.elapsedMs.toFixed(2)} ms in WebAssembly)`;
      };

      fnSelect.addEventListener('change', () => {
        syncArgInput();
        execute();
      });
      runBtn.addEventListener('click', execute);
      argInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') execute(); });

      runner.append(controls, output);
      stageEl.appendChild(runner);
      syncArgInput();
      execute();
    }

    stageEl.appendChild(renderSourceCard(ex, false));
  }
}

function selectExample(slug, pushHash = true) {
  const ex = manifest.examples.find(e => e.slug === slug) || manifest.examples[0];
  if (!ex) return;
  activeSlug = ex.slug;
  if (pushHash) {
    const targetHash = `#example=${encodeURIComponent(ex.slug)}`;
    if (location.hash !== targetHash) history.replaceState(null, '', targetHash);
  }
  renderList();
  renderExample(ex);
}

function slugFromHash() {
  const m = /example=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

async function boot() {
  registerIsolationWorker();
  const resp = await fetch('./manifest.json');
  if (!resp.ok) throw new Error(`manifest.json: HTTP ${resp.status}`);
  manifest = await resp.json();
  if (!manifest.hasDocs) docsLink.hidden = true;
  const penCount = manifest.examples.filter(e => e.kind === 'pen').length;
  const wasmCount = manifest.examples.filter(e => e.kind === 'wasm').length;
  statsLabel.textContent = `${penCount} live Pen WebGPU demos · ${wasmCount} browser Wasm examples`;
  renderCategories();
  const initial = slugFromHash() || manifest.examples[0]?.slug;
  selectExample(initial, false);
  window.addEventListener('hashchange', () => {
    const next = slugFromHash();
    if (next && next !== activeSlug) selectExample(next, false);
  });
}

boot().catch(err => {
  stageEl.innerHTML = `<div class="loading-card">Failed to load gallery: ${escapeHtml(String(err))}</div>`;
});
