/* ============================================================================
   FOUNDRY — MOTION ENGINE
   Physics-based springs (damped harmonic oscillator), scroll reveals,
   pointer tilt, and scroll-driven progress. Compositor-only properties.
============================================================================ */
(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* -------------------------------------------------------------------------
     Spring — damped harmonic oscillator, semi-implicit Euler integration.
     stiffness/damping chosen for a settled-in ~600ms feel, no visible wobble
     on large elements, slight life on small ones.
  ------------------------------------------------------------------------- */
  function Spring(value, stiffness, damping) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness || 120;
    this.damping = damping || 18;
  }

  Spring.prototype.set = function (target) {
    this.target = target;
  };

  Spring.prototype.snap = function (value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  };

  Spring.prototype.step = function (dt) {
    var force = -this.stiffness * (this.value - this.target);
    var damp = -this.damping * this.velocity;
    this.velocity += (force + damp) * dt;
    this.value += this.velocity * dt;
    return this.value;
  };

  Spring.prototype.settled = function () {
    return (
      Math.abs(this.velocity) < 0.001 &&
      Math.abs(this.value - this.target) < 0.001
    );
  };

  /* -------------------------------------------------------------------------
     Scroll reveal — IntersectionObserver, stagger via --rd custom property.
  ------------------------------------------------------------------------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) {
      el.classList.add("is-in");
    });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealEls.forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /* -------------------------------------------------------------------------
     Nav glass state
  ------------------------------------------------------------------------- */
  var nav = document.getElementById("nav");

  function updateNav() {
    if (!nav) return;
    nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }

  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  /* -------------------------------------------------------------------------
     Hero console — pointer tilt on real springs.
  ------------------------------------------------------------------------- */
  var wrap = document.getElementById("consoleWrap");

  if (wrap && !reduceMotion && window.matchMedia("(pointer: fine)").matches) {
    var rx = new Spring(0, 90, 16);
    var ry = new Spring(0, 90, 16);
    var ticking = false;
    var last = 0;

    function tiltLoop(now) {
      var dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      rx.step(dt);
      ry.step(dt);
      wrap.style.transform =
        "rotateX(" + rx.value.toFixed(3) + "deg) rotateY(" + ry.value.toFixed(3) + "deg)";
      if (rx.settled() && ry.settled()) {
        ticking = false;
        return;
      }
      requestAnimationFrame(tiltLoop);
    }

    function kick() {
      if (!ticking) {
        ticking = true;
        last = performance.now();
        requestAnimationFrame(tiltLoop);
      }
    }

    var hero = wrap.closest(".hero-visual");

    hero.addEventListener("pointermove", function (e) {
      var rect = wrap.getBoundingClientRect();
      var px = (e.clientX - rect.left) / rect.width - 0.5;
      var py = (e.clientY - rect.top) / rect.height - 0.5;
      ry.set(px * 5);
      rx.set(-py * 4);
      kick();
    });

    hero.addEventListener("pointerleave", function () {
      rx.set(0);
      ry.set(0);
      kick();
    });
  }

  /* -------------------------------------------------------------------------
     Number tickers — spring-driven count-up on first visibility.
  ------------------------------------------------------------------------- */
  var counters = Array.prototype.slice.call(document.querySelectorAll("[data-count]"));

  function runCounter(el) {
    var target = parseInt(el.getAttribute("data-count"), 10) || 0;
    if (reduceMotion) {
      el.textContent = String(target);
      return;
    }
    var spring = new Spring(0, 60, 14);
    spring.set(target);
    var last = performance.now();

    function frame(now) {
      var dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      var v = spring.step(dt);
      el.textContent = String(Math.round(v));
      if (!spring.settled()) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = String(target);
      }
    }

    requestAnimationFrame(frame);
  }

  if (counters.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      counters.forEach(runCounter);
    } else {
      var counterObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              runCounter(entry.target);
              counterObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.4 }
      );
      counters.forEach(function (el) {
        counterObserver.observe(el);
      });
    }
  }

  /* -------------------------------------------------------------------------
     Loop rail — scroll-driven progress, rAF-throttled, transform only.
  ------------------------------------------------------------------------- */
  var steps = document.getElementById("loopSteps");
  var railFill = document.getElementById("loopRailFill");

  if (steps && railFill && !reduceMotion) {
    var railQueued = false;

    function updateRail() {
      railQueued = false;
      var rect = steps.getBoundingClientRect();
      var vh = window.innerHeight;
      var trigger = vh * 0.62;
      var progress = (trigger - rect.top) / rect.height;
      progress = Math.max(0, Math.min(1, progress));
      railFill.style.transform = "scaleY(" + progress.toFixed(4) + ")";
    }

    function queueRail() {
      if (!railQueued) {
        railQueued = true;
        requestAnimationFrame(updateRail);
      }
    }

    window.addEventListener("scroll", queueRail, { passive: true });
    window.addEventListener("resize", queueRail, { passive: true });
    updateRail();
  } else if (railFill) {
    railFill.style.transform = "scaleY(1)";
  }

  /* -------------------------------------------------------------------------
     Footer year
  ------------------------------------------------------------------------- */
  var year = document.getElementById("year");
  if (year) {
    year.textContent = String(new Date().getFullYear());
  }
})();
