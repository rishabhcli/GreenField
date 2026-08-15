/* ============================================================================
   YELLOFIELD — MOTION ENGINE
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
     Nav float state — docked flush at the very top, a floating glass pill
     the moment the page scrolls. Transform/geometry only, CSS transitions
     carry the animation.
  ------------------------------------------------------------------------- */
  var nav = document.getElementById("nav");

  function updateNav() {
    if (!nav) return;
    nav.classList.toggle("is-floating", window.scrollY > 24);
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
     Hero LED field — a crowd wave across a matrix of neon squares.

     Two sources sum into every LED:
       ambient   a crest travelling across the field with each row phase-lagged.
                 That lag is the whole trick: an unlagged crest reads as a
                 moving bar, a lagged one reads as a crowd standing up in
                 sequence. The rising edge is narrower than the falling one
                 because people stand faster than they sit.
       bloom     recent pointer samples, each losing amplitude while gaining
                 radius, so the trail swells and dies behind the cursor.

     Per-frame cost stays flat by quantising intensity into fixed buckets and
     issuing one batched path fill per bucket, instead of one fillStyle
     assignment per LED. The additive glow sprite is reserved for the few LEDs
     above the hot threshold.
  ------------------------------------------------------------------------- */
  var ledCanvas = document.getElementById("heroLeds");
  var ledCtx = ledCanvas && ledCanvas.getContext ? ledCanvas.getContext("2d") : null;
  var heroSection = document.querySelector(".hero");

  if (ledCtx && heroSection) {
    var PITCH = 17; /* grid spacing, CSS px — dense enough to read as a panel */
    var SIZE = 2.5; /* emitter edge length */
    var LENS = 4.6; /* diode package: the dark lens the emitter sits inside */
    var LEVELS = 16; /* brightness buckets */
    var HOT = 0.42; /* above this an LED also gets additive bloom sprites */
    var SPRITE_CAP = 1400; /* hard ceiling on additive draws per frame */
    var ATTACK = 34; /* per-diode rise rate — LEDs switch on fast */
    var DECAY = 7.5; /* per-diode fall rate — and bleed off slower */
    var TRAIL_MS = 820; /* pointer sample lifetime */
    var TRAIL_GAP = 16; /* min px between samples */
    var TRAIL_MAX = 30;
    var W_LEAD = 0.08; /* crest rising edge, in field widths */
    var W_TRAIL = 0.19; /* crest falling edge */
    var SKEW = 0.22; /* per-row phase lag */
    var REST = 0.055; /* unlit diode glow */

    var cols = 0;
    var rows = 0;
    var cw = 0;
    var ch = 0;
    var offX = 0;
    var offY = 0;
    var lx = null; /* LED pixel x */
    var ly = null; /* LED pixel y */
    var nx = null; /* normalised column 0..1 */
    var ny = null; /* normalised row 0..1 */
    var damp = null; /* legibility multiplier for the ambient wash */
    var dampB = null; /* gentler multiplier for the pointer bloom */
    var vary = null; /* per-LED brightness variance */
    var lit = null; /* scratch: ambient intensity */
    var blm = null; /* scratch: bloom intensity */
    var drive = null; /* persisted per-diode output — what actually gets drawn */
    var bucket = [];
    var bucketLen = null;
    var levelFill = [];
    var coreFill = [];
    var glowNear = null; /* tight halo — the epoxy dome scattering */
    var glowFar = null; /* wide bloom — light spilling across the panel */

    var hasRoundRect = typeof ledCtx.roundRect === "function";
    var phase = 0;
    var phase2 = 0;
    var lastMs = 0;
    var rafId = 0;
    var running = false;
    var inView = true;
    var laidOut = false;
    var originX = 0; /* cached canvas origin — see the pointermove handler */
    var originY = 0;
    var trail = [];
    var pointerIn = false;
    var headX = new Spring(0, 150, 20);
    var headY = new Spring(0, 150, 20);

    function rand2(a, b) {
      var s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return s - Math.floor(s);
    }

    /* Emitter colour ramp. A real yellow LED is not one colour at all drive
       levels: at low current it sits deep amber, climbs to saturated neon
       through the middle, and the die overwhelms the phosphor at the top so
       the centre bleaches toward white while the surrounding dome stays
       yellow. Two ramps encode that — the body colour and a hotter core. */
    function buildLevels() {
      levelFill = [];
      coreFill = [];
      for (var i = 0; i < LEVELS; i++) {
        var t = (i + 0.5) / LEVELS;

        var amber = t < 0.34 ? 1 - t / 0.34 : 0; /* deep amber at low drive */
        var bleach = t < 0.68 ? 0 : (t - 0.68) / 0.32; /* white-out at high drive */

        var r = 255;
        var g = Math.round(232 - 54 * amber + 19 * bleach);
        var b = Math.round(26 - 24 * amber + 198 * bleach);
        var a = 0.045 + 0.93 * Math.pow(t, 1.45);
        levelFill.push("rgba(" + r + "," + g + "," + b + "," + a.toFixed(3) + ")");

        /* The core is a smaller, hotter dot drawn on top of the body. It only
           earns its own pixels once the diode is genuinely driven. */
        var ct = Math.max(0, (t - 0.4) / 0.6);
        coreFill.push(
          "rgba(255," + Math.round(240 + 15 * ct) + "," + Math.round(120 + 135 * ct) + "," + (ct * 0.85).toFixed(3) + ")"
        );
      }
    }

    function radialSprite(size, stops) {
      var c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      var g = c.getContext("2d");
      if (!g) return null;
      var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (var i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return c;
    }

    /* Two bloom radii, because that is the actual optical signature of a point
       emitter behind a lens: a tight bright halo from the dome itself, plus a
       much wider, much fainter spill. One radius always reads as a fuzzy blob. */
    function buildGlow() {
      glowNear = radialSprite(32, [
        [0, "rgba(255,250,205,0.62)"],
        [0.26, "rgba(255,236,90,0.28)"],
        [0.62, "rgba(255,226,20,0.06)"],
        [1, "rgba(255,226,20,0)"],
      ]);
      glowFar = radialSprite(64, [
        [0, "rgba(255,232,26,0.13)"],
        [0.34, "rgba(255,226,20,0.055)"],
        [1, "rgba(255,220,10,0)"],
      ]);
    }

    /* Distance-outside-the-box falloff. The wave crosses the full width; over
       content it is damped rather than clipped, so nothing ever competes with
       the copy for contrast. The console gets a lower floor than the headline
       because its backdrop-filter smears whatever sits behind it into a wash
       across the entire panel. */
    function regionDamp(x, y, box) {
      var dx = Math.max(box.l - x, 0, x - box.r);
      var dy = Math.max(box.t - y, 0, y - box.b);
      var d = Math.sqrt(dx * dx + dy * dy);
      var t = Math.min(d / box.fade, 1);
      return box.floor + (1 - box.floor) * (t * t * (3 - 2 * t));
    }

    function measure(sel, canvasRect, pad, floor, fade) {
      var el = document.querySelector(sel);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return {
        l: r.left - canvasRect.left - pad,
        t: r.top - canvasRect.top - pad,
        r: r.right - canvasRect.left + pad,
        b: r.bottom - canvasRect.top + pad,
        floor: floor,
        fade: fade,
      };
    }

    function layout() {
      var rect = ledCanvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;

      originX = rect.left;
      originY = rect.top;

      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = rect.width;
      ch = rect.height;
      ledCanvas.width = Math.round(cw * dpr);
      ledCanvas.height = Math.round(ch * dpr);
      ledCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.max(2, Math.ceil(cw / PITCH) + 1);
      rows = Math.max(2, Math.ceil(ch / PITCH) + 1);
      offX = (cw - (cols - 1) * PITCH) / 2;
      offY = (ch - (rows - 1) * PITCH) / 2;

      var n = cols * rows;
      lx = new Float32Array(n);
      ly = new Float32Array(n);
      nx = new Float32Array(n);
      ny = new Float32Array(n);
      damp = new Float32Array(n);
      dampB = new Float32Array(n);
      vary = new Float32Array(n);
      lit = new Float32Array(n);
      blm = new Float32Array(n);
      bucket = [];
      for (var l = 0; l < LEVELS; l++) bucket.push(new Int32Array(n));
      bucketLen = new Int32Array(LEVELS);

      var regions = [];
      var copyBox = measure(".hero-copy", rect, 14, 0.4, 70);
      var consoleBox = measure(".console", rect, 8, 0.26, 56);
      if (copyBox) regions.push(copyBox);
      if (consoleBox) regions.push(consoleBox);

      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var i = r * cols + c;
          lx[i] = offX + c * PITCH;
          ly[i] = offY + r * PITCH;
          nx[i] = c / (cols - 1);
          ny[i] = r / (rows - 1);
          var m = 1;
          for (var g = 0; g < regions.length; g++) {
            var v = regionDamp(lx[i], ly[i], regions[g]);
            if (v < m) m = v;
          }
          damp[i] = m;
          /* The bloom is the interactive element and the eye tracks it, so it
             is allowed more presence over content than the ambient wash. A
             moving highlight costs far less legibility than a standing one. */
          dampB[i] = Math.pow(m, 0.45);
          vary[i] = 0.62 + 0.38 * rand2(c, r);
        }
      }

      laidOut = true;
      return true;
    }

    function addBloom(x, y, radius, amp) {
      if (amp <= 0.003) return;
      var c0 = Math.max(0, Math.floor((x - radius - offX) / PITCH));
      var c1 = Math.min(cols - 1, Math.ceil((x + radius - offX) / PITCH));
      var r0 = Math.max(0, Math.floor((y - radius - offY) / PITCH));
      var r1 = Math.min(rows - 1, Math.ceil((y + radius - offY) / PITCH));
      var rr = radius * radius;
      for (var r = r0; r <= r1; r++) {
        var base = r * cols;
        for (var c = c0; c <= c1; c++) {
          var i = base + c;
          var dx = lx[i] - x;
          var dy = ly[i] - y;
          var q = 1 - (dx * dx + dy * dy) / rr;
          if (q <= 0) continue;
          blm[i] += amp * q * q;
        }
      }
    }

    function draw(nowMs) {
      var n = cols * rows;
      var i;

      for (i = 0; i < n; i++) {
        /* Primary crest. Wrapping the distance makes it re-enter from the left
           as it exits right, so the wave repeats without a seam. */
        var d = nx[i] - (phase - SKEW * ny[i]);
        d -= Math.floor(d + 0.5);
        var w = d > 0 ? W_LEAD : W_TRAIL;
        var a = Math.exp(-(d * d) / (2 * w * w));

        /* Slower counter-wave, low amplitude, for depth. */
        var d2 = nx[i] + phase2 + 0.12 * ny[i];
        d2 -= Math.floor(d2 + 0.5);
        a += 0.34 * Math.exp(-(d2 * d2) / (2 * 0.01));

        /* Resting term keeps unlit diodes faintly visible, so the field reads
           as hardware that is off rather than as empty background. */
        lit[i] = a * vary[i] * 0.62 + REST;
      }

      blm.fill(0);

      for (var s = 0; s < trail.length; s++) {
        var age = (nowMs - trail[s].t) / TRAIL_MS;
        if (age >= 1) continue;
        var fall = (1 - age) * (1 - age);
        addBloom(trail[s].x, trail[s].y, 78 + age * 104, 0.95 * fall);
      }

      if (pointerIn) addBloom(headX.value, headY.value, 120, 1.35);

      for (i = 0; i < LEVELS; i++) bucketLen[i] = 0;

      for (i = 0; i < n; i++) {
        var v = lit[i] * damp[i] + blm[i] * dampB[i];
        if (v > 1) v = 1;
        var lv = (v * LEVELS) | 0;
        if (lv >= LEVELS) lv = LEVELS - 1;
        else if (lv < 0) lv = 0;
        bucket[lv][bucketLen[lv]++] = i;
      }

      ledCtx.clearRect(0, 0, cw, ch);
      ledCtx.globalCompositeOperation = "source-over";

      var half = SIZE / 2;
      for (var lv2 = 0; lv2 < LEVELS; lv2++) {
        var len = bucketLen[lv2];
        if (!len) continue;
        ledCtx.fillStyle = levelFill[lv2];
        ledCtx.beginPath();
        for (var k = 0; k < len; k++) {
          var idx = bucket[lv2][k];
          if (hasRoundRect) ledCtx.roundRect(lx[idx] - half, ly[idx] - half, SIZE, SIZE, 1.1);
          else ledCtx.rect(lx[idx] - half, ly[idx] - half, SIZE, SIZE);
        }
        ledCtx.fill();
      }

      if (glowNear || glowFar) {
        ledCtx.globalCompositeOperation = "lighter";
        var drawn = 0;
        /* Brightest bucket first: additive blending is commutative so the
           result is identical, but if SPRITE_CAP binds it is the dimmest hot
           LEDs that lose their halo rather than the crest itself. */
        var hotFloor = Math.floor(HOT * LEVELS);
        for (var lv3 = LEVELS - 1; lv3 >= hotFloor && drawn < SPRITE_CAP; lv3--) {
          var len3 = bucketLen[lv3];
          if (!len3) continue;
          var t = (lv3 + 0.5) / LEVELS;
          var farScale = 16 + 36 * t;
          var nearScale = 6 + 14 * t;
          var farHalf = farScale / 2;
          var nearHalf = nearScale / 2;
          for (var k3 = 0; k3 < len3 && drawn < SPRITE_CAP; k3++) {
            var id3 = bucket[lv3][k3];
            if (glowFar) {
              ledCtx.drawImage(glowFar, lx[id3] - farHalf, ly[id3] - farHalf, farScale, farScale);
            }
            if (glowNear) {
              ledCtx.drawImage(glowNear, lx[id3] - nearHalf, ly[id3] - nearHalf, nearScale, nearScale);
            }
            drawn++;
          }
        }
        ledCtx.globalCompositeOperation = "source-over";
      }
    }

    function loop(nowMs) {
      rafId = 0;
      var dt = Math.min((nowMs - lastMs) / 1000, 1 / 30);
      lastMs = nowMs;
      phase += dt * 0.115;
      phase -= Math.floor(phase);
      phase2 += dt * 0.043;
      phase2 -= Math.floor(phase2);
      headX.step(dt);
      headY.step(dt);
      draw(nowMs);
      if (running) rafId = requestAnimationFrame(loop);
    }

    function start() {
      if (running || reduceMotion || !laidOut) return;
      running = true;
      lastMs = performance.now();
      rafId = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function refresh() {
      var wasRunning = running;
      stop();
      if (!layout()) return;
      if (reduceMotion) {
        draw(performance.now());
        return;
      }
      if (wasRunning || inView) start();
      else draw(performance.now());
    }

    buildLevels();
    buildGlow();

    /* Reduced motion gets one static frame with the crest mid-field —
       deliberate, not blank. Set before the first layout so a hero that is
       not measurable yet still lands on the intended phase when it resizes in. */
    if (reduceMotion) phase = 0.5;

    if (layout()) {
      if (reduceMotion) draw(performance.now());
      else start();
    }

    if ("IntersectionObserver" in window) {
      var ledObserver = new IntersectionObserver(
        function (entries) {
          inView = entries[0].isIntersecting;
          if (inView) start();
          else stop();
        },
        { threshold: 0 }
      );
      ledObserver.observe(heroSection);
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop();
      else if (inView) start();
    });

    var resizeQueued = false;
    function queueResize() {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () {
        resizeQueued = false;
        refresh();
      });
    }

    if ("ResizeObserver" in window) new ResizeObserver(queueResize).observe(heroSection);
    else window.addEventListener("resize", queueResize, { passive: true });

    if (!reduceMotion && window.matchMedia("(pointer: fine)").matches) {
      /* The console tilt handler writes a transform every rAF, so reading a
         rect here would force a style recalc on every move. The origin is
         cached in layout() and refreshed on scroll instead. */
      var originQueued = false;
      window.addEventListener(
        "scroll",
        function () {
          if (originQueued || !laidOut) return;
          originQueued = true;
          requestAnimationFrame(function () {
            originQueued = false;
            var r = ledCanvas.getBoundingClientRect();
            originX = r.left;
            originY = r.top;
          });
        },
        { passive: true }
      );

      heroSection.addEventListener(
        "pointermove",
        function (e) {
          var x = e.clientX - originX;
          var y = e.clientY - originY;

          if (!pointerIn) {
            headX.snap(x);
            headY.snap(y);
            pointerIn = true;
          } else {
            headX.set(x);
            headY.set(y);
          }

          var last = trail[trail.length - 1];
          if (!last || Math.abs(last.x - x) + Math.abs(last.y - y) > TRAIL_GAP) {
            trail.push({ x: x, y: y, t: performance.now() });
            if (trail.length > TRAIL_MAX) trail.shift();
          }
        },
        { passive: true }
      );

      /* Samples already in flight keep decaying — the trail dies on its own
         rather than being cut. */
      heroSection.addEventListener("pointerleave", function () {
        pointerIn = false;
      });
    }
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

/* ============================================================================
   LAYER 2 — additive polish.
   Scroll progress hairline, pointer-tracked card spotlight, active-section
   nav state, current loop step, FAQ accordion, mobile menu. Every block is
   null-guarded so a reduced DOM (or the test harness) simply skips it.
============================================================================ */
(function () {
  "use strict";

  var reduceMotion2 =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* -------------------------------------------------------------------------
     Scroll progress — scaleX only, rAF-throttled.
  ------------------------------------------------------------------------- */
  var progressFill = document.getElementById("scrollProgressFill");

  if (progressFill) {
    var progressQueued = false;

    function updateProgress() {
      progressQueued = false;
      var doc = document.documentElement;
      var max = doc ? doc.scrollHeight - window.innerHeight : 0;
      var p = max > 0 ? window.scrollY / max : 0;
      progressFill.style.transform = "scaleX(" + Math.max(0, Math.min(1, p)).toFixed(4) + ")";
    }

    function queueProgress() {
      if (!progressQueued) {
        progressQueued = true;
        requestAnimationFrame(updateProgress);
      }
    }

    window.addEventListener("scroll", queueProgress, { passive: true });
    window.addEventListener("resize", queueProgress, { passive: true });
    updateProgress();
  }

  /* -------------------------------------------------------------------------
     Card spotlight — a faint warm radial that trails the pointer.
     The element is created lazily; hosts come from querySelectorAll, so an
     empty DOM yields zero work.
  ------------------------------------------------------------------------- */
  var spotHosts = Array.prototype.slice.call(
    document.querySelectorAll(".bento-card, .gov-card, .stat")
  );

  if (spotHosts.length && !reduceMotion2 && window.matchMedia("(pointer: fine)").matches) {
    spotHosts.forEach(function (card) {
      var spot = document.createElement("span");
      spot.className = "card-spot";
      spot.setAttribute("aria-hidden", "true");
      card.appendChild(spot);

      card.addEventListener("pointerenter", function () {
        spot.style.opacity = "1";
      });

      card.addEventListener("pointermove", function (e) {
        var rect = card.getBoundingClientRect();
        var x = e.clientX - rect.left - 170;
        var y = e.clientY - rect.top - 170;
        spot.style.transform = "translate3d(" + x + "px," + y + "px,0)";
      });

      card.addEventListener("pointerleave", function () {
        spot.style.opacity = "0";
      });
    });
  }

  /* -------------------------------------------------------------------------
     Active section in the nav — IntersectionObserver band across the middle.
  ------------------------------------------------------------------------- */
  var navAnchors = Array.prototype.slice.call(
    document.querySelectorAll(".nav-links a[href^='#']")
  );
  var watched = [];

  navAnchors.forEach(function (a) {
    var id = (a.getAttribute("href") || "").slice(1);
    var sec = id ? document.getElementById(id) : null;
    if (sec) watched.push({ id: id, el: sec, link: a });
  });

  if (watched.length && "IntersectionObserver" in window) {
    var navObserver2 = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          watched.forEach(function (s) {
            s.link.classList.toggle("is-active", s.id === entry.target.id);
          });
        });
      },
      { rootMargin: "-38% 0px -55% 0px", threshold: 0 }
    );
    watched.forEach(function (s) {
      navObserver2.observe(s.el);
    });
  }

  /* -------------------------------------------------------------------------
     Current loop step — the step nearest viewport center gets the marker.
  ------------------------------------------------------------------------- */
  var loopStepsHost = document.getElementById("loopSteps");

  if (loopStepsHost) {
    var stepEls = Array.prototype.slice.call(loopStepsHost.querySelectorAll(".loop-step"));
    var stepQueued = false;

    function updateCurrentStep() {
      stepQueued = false;
      if (!stepEls.length) return;
      var center = window.innerHeight * 0.5;
      var best = -1;
      var bestDist = Infinity;
      for (var i = 0; i < stepEls.length; i++) {
        var r = stepEls[i].getBoundingClientRect();
        var mid = r.top + r.height / 2;
        var d = Math.abs(mid - center);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      for (var j = 0; j < stepEls.length; j++) {
        stepEls[j].classList.toggle("is-current", j === best && bestDist < window.innerHeight * 0.45);
      }
    }

    function queueStep() {
      if (!stepQueued) {
        stepQueued = true;
        requestAnimationFrame(updateCurrentStep);
      }
    }

    if (stepEls.length) {
      window.addEventListener("scroll", queueStep, { passive: true });
      window.addEventListener("resize", queueStep, { passive: true });
      updateCurrentStep();
    }
  }

  /* -------------------------------------------------------------------------
     FAQ accordion — class + aria-expanded; CSS grid-rows does the motion.
  ------------------------------------------------------------------------- */
  var faqItems = Array.prototype.slice.call(document.querySelectorAll(".faq-item"));

  faqItems.forEach(function (item) {
    var btn = item.querySelector(".faq-q");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var open = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  /* -------------------------------------------------------------------------
     Mobile menu — hidden-attribute toggle, closes on navigate or Escape.
  ------------------------------------------------------------------------- */
  var menuBtn = document.getElementById("navMenuBtn");
  var navPanel = document.getElementById("navPanel");

  if (menuBtn && navPanel) {
    function setMenu(open) {
      if (open) {
        navPanel.removeAttribute("hidden");
      } else {
        navPanel.setAttribute("hidden", "");
      }
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menuBtn.classList.toggle("is-open", open);
    }

    menuBtn.addEventListener("click", function () {
      setMenu(menuBtn.getAttribute("aria-expanded") !== "true");
    });

    Array.prototype.slice.call(navPanel.querySelectorAll("a")).forEach(function (a) {
      a.addEventListener("click", function () {
        setMenu(false);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menuBtn.getAttribute("aria-expanded") === "true") {
        setMenu(false);
      }
    });
  }
})();
