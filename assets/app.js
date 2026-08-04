/* stek.ai — front-end behaviour: theme, language menu, mobile nav, reveal, contact form */
(function () {
  "use strict";
  var d = document;

  /* ---- theme ---------------------------------------------------------- */
  var tbtn = d.getElementById("theme");
  if (tbtn) {
    tbtn.addEventListener("click", function () {
      var next = d.documentElement.dataset.theme === "dark" ? "light" : "dark";
      d.documentElement.dataset.theme = next;
      try { localStorage.setItem("stek-theme", next); } catch (e) {}
    });
  }

  /* ---- language menu -------------------------------------------------- */
  var lb = d.getElementById("langbtn"), lm = d.getElementById("langm");
  if (lb && lm) {
    lb.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var open = lm.classList.toggle("open");
      lb.setAttribute("aria-expanded", open ? "true" : "false");
    });
    d.addEventListener("click", function (ev) {
      if (!lm.contains(ev.target)) { lm.classList.remove("open"); lb.setAttribute("aria-expanded", "false"); }
    });
    d.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { lm.classList.remove("open"); lb.setAttribute("aria-expanded", "false"); }
    });
  }

  /* ---- mobile nav ----------------------------------------------------- */
  var bg = d.getElementById("burger"), mob = d.getElementById("mob");
  if (bg && mob) {
    bg.addEventListener("click", function () {
      var open = mob.classList.toggle("open");
      bg.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---- reveal on scroll ----------------------------------------------- */
  var rv = d.querySelectorAll(".rv");
  if (rv.length) {
    if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      rv.forEach(function (el) { el.classList.add("in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en, i) {
          if (en.isIntersecting) {
            setTimeout(function () { en.target.classList.add("in"); }, Math.min(i * 70, 280));
            io.unobserve(en.target);
          }
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      rv.forEach(function (el) { io.observe(el); });
    }
  }

  /* ---- contact form --------------------------------------------------- */
  var form = d.getElementById("cform");
  if (!form) return;
  var errBox = d.getElementById("err"), done = d.getElementById("done"), btn = d.getElementById("submit");
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function fail(msg) {
    errBox.textContent = msg;
    errBox.classList.add("on");
    errBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    errBox.classList.remove("on");
    var fd = new FormData(form), o = {};
    fd.forEach(function (v, k) { o[k] = typeof v === "string" ? v.trim() : v; });

    if (!o.name || !o.email || !o.message || !o.kind) return fail(form.dataset.errRequired);
    if (!EMAIL.test(o.email)) return fail(form.dataset.errEmail);

    btn.disabled = true;
    btn.textContent = form.dataset.sending;

    fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; });
    }).then(function (j) {
      if (j && j.ok) {
        form.style.display = "none";
        done.classList.add("on");
        done.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        throw new Error((j && j.error) || "send failed");
      }
    }).catch(function () {
      fail(form.dataset.errSend);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = form.dataset.submit;
    });
  });
})();
