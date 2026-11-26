(function () {
  var TRAP_SITE_OFFSET = 772;
  var BTST_MAGIC = 0x42545354;

  function decodeBase64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decodeText(words) {
    var parts = [];
    for (var i = 0; i < words.length; i++) {
      var cp = words[i];
      if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
        throw new Error("Invalid Unicode scalar: " + cp);
      }
      parts.push(String.fromCodePoint(cp));
    }
    return parts.join("");
  }

  function readTrapTable(mod) {
    var sections = WebAssembly.Module.customSections(mod, "blot:traps");
    if (!sections.length) return [];
    var bytes = new Uint8Array(sections[0]);
    if (bytes.length < 5 || bytes[0] !== 1) return [];
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var count = view.getUint32(1, true);
    var off = 5;
    var dec = new TextDecoder("utf-8");
    var entries = [];
    for (var i = 0; i < count && off + 17 <= bytes.length; i++) {
      var k = bytes[off++];
      var kind = k === 1 ? "panic" : k === 2 ? "bounds" : "unreachable";
      off += 12; // unit, start, end
      var len = view.getUint32(off, true);
      off += 4;
      var msg = dec.decode(bytes.subarray(off, off + len));
      off += len;
      entries.push({ kind: kind, message: msg });
    }
    return entries;
  }

  function formatTrap(err, traps, mem) {
    if (mem && mem.buffer.byteLength >= TRAP_SITE_OFFSET + 4 && traps.length) {
      var id = new DataView(mem.buffer).getUint32(TRAP_SITE_OFFSET, true);
      if (id >= 1 && id <= traps.length) {
        var t = traps[id - 1];
        if (t.kind === "panic") return t.message ? 'panic: "' + t.message + '"' : "panic";
        if (t.kind === "bounds") return t.message || "index out of bounds";
        return t.message ? "unreachable: " + t.message : "unreachable";
      }
    }
    return err && err.message ? err.message : String(err);
  }

  function readArray(mem, ptr, kind) {
    var view = new DataView(mem.buffer);
    var len = view.getUint32(ptr, true);
    if (kind === "Array F32") {
      var f = new Float32Array(len);
      for (var i = 0; i < len; i++) f[i] = view.getFloat32(ptr + 4 + i * 4, true);
      return f;
    }
    var u = new Uint32Array(len);
    for (var j = 0; j < len; j++) u[j] = view.getUint32(ptr + 4 + j * 4, true);
    return u;
  }

  function decodeBtst(words) {
    if (words.length < 4 || words[0] !== BTST_MAGIC || words[1] !== 1) return null;
    var passed = words[2];
    var failed = words[3];
    var off = 4;
    function str() {
      var len = words[off++];
      var s = decodeText(words.subarray(off, off + len));
      off += len;
      return s;
    }
    var failures = [];
    for (var i = 0; i < failed; i++) {
      failures.push({ group: str(), label: str(), message: str(), expected: str(), actual: str() });
    }
    return { passed: passed, failed: failed, failures: failures };
  }

  function formatF32(v) {
    if (!Number.isFinite(v)) return String(v);
    var s = String(Math.fround(v));
    return s.indexOf(".") === -1 && s.indexOf("e") === -1 ? s + ".0" : s;
  }

  async function runExample(spec) {
    var bytes = decodeBase64(spec.wasmBase64);
    var mod = await WebAssembly.compile(bytes);
    var traps = readTrapTable(mod);
    var inst = await WebAssembly.instantiate(mod, {});
    var exp = inst.exports;
    var mem = exp["blot:memory"] || exp.memory;
    var reset = exp["blot:reset"];
    var finish = exp["blot:finish_invocation"];

    if (spec.isTestSuite && spec.tests && spec.tests.length) {
      var passed = 0;
      var failed = 0;
      var lines = [];
      for (var i = 0; i < spec.tests.length; i++) {
        var t = spec.tests[i];
        if (typeof reset === "function") reset(0);
        try {
          exp[t.exportName]();
          if (typeof finish === "function") finish();
          if (t.kind === "trap") {
            failed++;
            lines.push("✗ " + t.displayName + " (expected trap, returned normally)");
          } else {
            passed++;
            lines.push("✓ " + t.displayName);
          }
        } catch (err) {
          if (t.kind === "trap") {
            passed++;
            lines.push("✓ " + t.displayName + " (trapped as expected: " + formatTrap(err, traps, mem) + ")");
          } else {
            failed++;
            lines.push("✗ " + t.displayName + " (" + formatTrap(err, traps, mem) + ")");
          }
        }
      }
      lines.push(passed + " passed, " + failed + " failed");
      return { ok: failed === 0, text: lines.join("\n") };
    }

    if (typeof reset === "function") reset(0);
    try {
      var raw = exp[spec.entry]();
      if (typeof finish === "function") finish();
      var text = "()";
      if (spec.resultType === "U32") text = String(raw >>> 0);
      else if (spec.resultType === "Bool") text = raw ? "true" : "false";
      else if (spec.resultType === "F32") text = formatF32(raw);
      else if (spec.resultType === "Array U32") {
        var words = readArray(mem, raw >>> 0, "Array U32");
        var btst = decodeBtst(words);
        if (btst) {
          var summary = btst.passed + " passed, " + btst.failed + " failed";
          if (btst.failed > 0) {
            var errs = btst.failures.map(function (f) {
              return "✗ " + f.label + ": " + f.message;
            });
            return { ok: false, text: errs.concat([summary]).join("\n") };
          }
          return { ok: true, text: "✓ " + summary };
        }
        text = spec.isText ? JSON.stringify(decodeText(words)) : "#[" + Array.from(words).join(", ") + "]";
      } else if (spec.resultType === "Array F32") {
        var floats = readArray(mem, raw >>> 0, "Array F32");
        text = "#[" + Array.from(floats).map(formatF32).join(", ") + "]";
      }
      var suffix = spec.expected ? "  (expected " + spec.expected + ")" : "";
      return { ok: true, text: "=> " + text + suffix };
    } catch (err) {
      return { ok: false, text: "trap: " + formatTrap(err, traps, mem) };
    }
  }

  if (typeof globalThis !== "undefined") {
    globalThis.__blotDocRunExample = runExample;
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target || !target.closest) return;
      var copyBtn = target.closest("[data-copy-code]");
      if (copyBtn) {
        var wrap = copyBtn.closest(".code-example, .code-block");
        var codeEl = wrap && wrap.querySelector("pre code");
        if (codeEl && navigator.clipboard) {
          navigator.clipboard.writeText(codeEl.textContent || "").then(function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
          });
        }
        return;
      }
      var runBtn = target.closest("[data-run-example]");
      if (runBtn) {
        var id = runBtn.getAttribute("data-run-example");
        var box = runBtn.closest(".code-example");
        var outEl = box && box.querySelector(".example-output");
        var map = globalThis.__BLOT_DOC_EXAMPLES || {};
        var spec = map[id];
        if (!spec || !outEl) return;
        outEl.hidden = false;
        outEl.className = "example-output";
        outEl.textContent = "Running…";
        var t0 = performance.now();
        runExample(spec).then(function (res) {
          var ms = (performance.now() - t0).toFixed(1);
          outEl.className = "example-output " + (res.ok ? "ok" : "err");
          outEl.textContent = res.text + "  [" + ms + " ms]";
        }).catch(function (err) {
          outEl.className = "example-output err";
          outEl.textContent = "Error: " + (err && err.message ? err.message : String(err));
        });
      }
    });
  }
})();
