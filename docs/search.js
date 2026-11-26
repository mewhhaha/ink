(function () {
  var input = document.getElementById("doc-search");
  var box = document.getElementById("search-results");
  if (!input || !box) return;
  var root = document.body.getAttribute("data-root") || "";
  var items = globalThis.__BLOT_DOC_SEARCH || [];

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(query) {
    var q = query.trim().toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    var matches = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var hay = (it.name + " " + it.module + " " + it.signature + " " + it.summary).toLowerCase();
      var idx = hay.indexOf(q);
      if (idx !== -1) {
        var score = it.name.toLowerCase() === q ? 0 : it.name.toLowerCase().indexOf(q) === 0 ? 1 : idx;
        matches.push({ score: score, item: it });
      }
    }
    matches.sort(function (a, b) { return a.score - b.score; });
    matches = matches.slice(0, 20);
    if (!matches.length) {
      box.innerHTML = '<div class="search-item">No matching symbols</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = matches.map(function (m) {
      var it = m.item;
      return '<a class="search-item" href="' + esc(root + it.href) + '">' +
        '<div class="search-item-head"><span class="item-kind kind-' + esc(it.kind) + '">' + esc(it.kind) + '</span>' +
        '<strong>' + esc(it.name) + '</strong>' +
        '<span class="pill">' + esc(it.module) + '</span></div>' +
        '<div class="search-item-sig">' + esc(it.signature) + '</div></a>';
    }).join("");
    box.hidden = false;
  }

  input.addEventListener("input", function () { render(input.value); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && document.activeElement !== input) {
      ev.preventDefault();
      input.focus();
    } else if (ev.key === "Escape") {
      box.hidden = true;
      input.blur();
    }
  });
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest || !ev.target.closest(".search-box")) {
      box.hidden = true;
    }
  });
})();
