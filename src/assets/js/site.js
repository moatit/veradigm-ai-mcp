/* Drawbridge site script. No third-party code, no cookies, no tracking.
   Analytics are off; see docs/campaign/TRACKING_PLAN.md for the consent-gated plan. */
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  /* ---- mobile navigation ---- */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      nav.classList.toggle("is-open", !open);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  /* ---- play the sample demos when they scroll into view ---- */
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var players = document.querySelectorAll("[data-play]");
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("is-playing");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.35 });
    players.forEach(function (p) { p.classList.add("will-play"); io.observe(p); });
  }
  document.querySelectorAll("[data-replay]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-replay"));
      if (!el || reduce) return;
      el.classList.remove("is-playing");
      void el.offsetWidth; // restart CSS animations
      el.classList.add("will-play", "is-playing");
    });
  });

  /* ---- ROI calculator ---- */
  var roi = document.getElementById("roi-form");
  if (roi) {
    var fmt = function (n, d) { return n.toLocaleString("en-US", { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }); };
    var money = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
    var val = function (id) {
      var el = document.getElementById(id);
      var v = parseFloat(el && el.value);
      var min = parseFloat(el.min), max = parseFloat(el.max);
      if (!isFinite(v)) v = 0;
      if (isFinite(min)) v = Math.max(min, v);
      if (isFinite(max)) v = Math.min(max, v);
      return v;
    };
    var set = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text; };
    var calc = function () {
      var docs = val("r-docs"), idx = val("r-idx"), auto = val("r-auto") / 100, assist = val("r-assist");
      var calls = val("r-calls"), handled = val("r-handled") / 100, mins = val("r-mins"), after = val("r-after");
      var rate = val("r-rate"), days = val("r-days");
      var faxH = (docs * auto * idx + docs * (1 - auto) * assist) * days / 60;
      var phoneH = calls * handled * mins * days / 60;
      var total = faxH + phoneH;
      var fte = total / 160;
      set("o-total", fmt(total));
      set("o-fax", fmt(faxH) + " h");
      set("o-phone", fmt(phoneH) + " h");
      set("o-fte", fmt(fte, 2));
      set("o-month", money(total * rate));
      set("o-year", money(total * rate * 12));
      set("o-after", fmt(after * 30));
    };
    roi.addEventListener("input", calc);
    roi.addEventListener("submit", function (e) { e.preventDefault(); calc(); });
    calc();
  }

  /* ---- campaign attribution: keep utm_* and the landing page for this tab only ---- */
  var attribution = {};
  try {
    var params = new URLSearchParams(window.location.search);
    var fresh = {};
    params.forEach(function (v, k) { if (/^utm_(source|medium|campaign|content|term)$/.test(k)) fresh[k] = v.slice(0, 100); });
    if (Object.keys(fresh).length) {
      fresh.landing_path = window.location.pathname;
      sessionStorage.setItem("db_attr", JSON.stringify(fresh));
    }
    attribution = JSON.parse(sessionStorage.getItem("db_attr") || "{}");
  } catch (e) { attribution = {}; }

  /* ---- demo request form (posts JSON to a placeholder endpoint) ---- */
  var form = document.getElementById("demo-form");
  if (form) {
    var status = document.getElementById("form-status");
    var required = form.querySelectorAll("[required]");
    var showError = function (input, on) {
      var f = input.closest(".field");
      if (!f) return;
      f.classList.toggle("has-error", on);
      input.setAttribute("aria-invalid", on ? "true" : "false");
    };
    required.forEach(function (input) {
      input.addEventListener("blur", function () { if (input.value) showError(input, !input.checkValidity()); });
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var firstBad = null;
      required.forEach(function (input) {
        var bad = !input.checkValidity();
        showError(input, bad);
        if (bad && !firstBad) firstBad = input;
      });
      if (firstBad) { firstBad.focus(); return; }
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      if (data.company_website) { return; } // honeypot
      delete data.company_website;
      Object.keys(attribution).forEach(function (k) { data[k] = attribution[k]; });
      data.form_path = window.location.pathname;
      var topic = new URLSearchParams(window.location.search).get("topic");
      if (topic) data.topic = topic.slice(0, 40);
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      status.className = "form-status";
      fetch(form.getAttribute("data-endpoint") || form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(data),
        credentials: "omit"
      }).then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        status.className = "form-status ok";
        status.innerHTML = "<strong>Thank you. Your request is in.</strong> A MOATiT team member will reply within one business day to set up your 20-minute walkthrough. Questions sooner? Call <a href=\"tel:+12089006628\">(208) 900-6628</a>.";
        form.reset();
      }).catch(function () {
        status.className = "form-status err";
        status.innerHTML = "<strong>We couldn't send the form just now.</strong> Please email <a href=\"mailto:questions@moatit.com?subject=Drawbridge%20walkthrough\">questions@moatit.com</a> or call <a href=\"tel:+12089006628\">(208) 900-6628</a> / <a href=\"tel:+18555506628\">(855) 550-6628</a>.";
      }).then(function () {
        btn.disabled = false;
        status.setAttribute("tabindex", "-1");
        status.focus();
      });
    });
  }
})();
