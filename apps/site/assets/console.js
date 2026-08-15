/* ============================================================================
   YELLOFIELD — OPERATOR CONSOLE
   Zero dependencies, no build step. Mirrors apps/site: plain static assets.

   The governing constraint, inherited from the rest of the system: this console
   may never assert something it has not read. Practical consequences you will
   see repeated throughout this file —

     * There is no placeholder data. A panel that has not loaded shows a
       skeleton; a panel that loaded and found nothing shows an empty state; a
       panel whose request failed shows the failure. Those are three different
       renders on purpose.
     * A failed poll does not silently keep the previous screen. The connection
       pill turns red and a banner appears, because a frozen dashboard that
       looks healthy is worse than one that admits it is blind.
     * `live_verified` is echoed from the API verbatim. The console never
       upgrades a status, and never infers "working" from the presence of a key.
============================================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Config
  ------------------------------------------------------------------------ */

  var POLL_MS = 15000;
  var AUDIT_LIMIT = 25;

  /**
   * API base resolution, most explicit wins:
   *   1. ?api=https://…      (also persisted, so a bookmark keeps working)
   *   2. localStorage
   *   3. the page's own origin, when served from something other than a file
   *   4. localhost:3000
   */
  function resolveApiBase() {
    var qs = new URLSearchParams(window.location.search);
    var fromQuery = qs.get('api');
    if (fromQuery) {
      try {
        localStorage.setItem('yf.apiBase', fromQuery);
      } catch (e) {
        /* private mode — the query param still applies for this page load */
      }
      return fromQuery.replace(/\/+$/, '');
    }
    var stored = null;
    try {
      stored = localStorage.getItem('yf.apiBase');
    } catch (e) {
      /* ignore */
    }
    if (stored) return stored.replace(/\/+$/, '');
    if (window.location.protocol === 'file:') return 'http://localhost:3000';
    return window.location.origin;
  }

  var API = resolveApiBase();

  /* ------------------------------------------------------------------------
     Token — sessionStorage only, so it dies with the tab
  ------------------------------------------------------------------------ */

  var auth = {
    token: null,
    operator: null,
    load: function () {
      try {
        this.token = sessionStorage.getItem('yf.token');
        this.operator = sessionStorage.getItem('yf.operator');
      } catch (e) {
        /* ignore */
      }
    },
    save: function (token, operator) {
      this.token = token || null;
      this.operator = operator || null;
      try {
        if (this.token) sessionStorage.setItem('yf.token', this.token);
        else sessionStorage.removeItem('yf.token');
        if (this.operator) sessionStorage.setItem('yf.operator', this.operator);
        else sessionStorage.removeItem('yf.operator');
      } catch (e) {
        /* ignore */
      }
    },
    get unlocked() {
      return Boolean(this.token);
    },
  };
  auth.load();

  /* ------------------------------------------------------------------------
     Small helpers
  ------------------------------------------------------------------------ */

  var $ = function (id) {
    return document.getElementById(id);
  };

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Minor units → display. Returns null when the input is not a real number,
      so callers render an em dash rather than "$0.00" for missing data. */
  function money(minor, currency) {
    if (typeof minor !== 'number' || !isFinite(minor)) return null;
    var code = currency || 'USD';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
      }).format(minor / 100);
    } catch (e) {
      return (minor / 100).toFixed(2) + ' ' + code;
    }
  }

  function relTime(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    var secs = Math.round((Date.now() - t) / 1000);
    if (secs < 0) return 'in ' + shortDuration(-secs);
    if (secs < 10) return 'just now';
    return shortDuration(secs) + ' ago';
  }

  function shortDuration(secs) {
    if (secs < 60) return secs + 's';
    if (secs < 3600) return Math.round(secs / 60) + 'm';
    if (secs < 86400) return Math.round(secs / 3600) + 'h';
    return Math.round(secs / 86400) + 'd';
  }

  function humanize(key) {
    if (!key) return '';
    return String(key).replace(/_/g, ' ');
  }

  function skeleton(lines) {
    var out = '<div style="padding:14px 16px">';
    for (var i = 0; i < (lines || 3); i++) {
      out += '<div class="cnsl-skel cnsl-skel-line"></div>';
    }
    return out + '</div>';
  }

  function emptyState(text, tone, icon) {
    return (
      '<div class="cnsl-empty" data-tone="' +
      esc(tone || '') +
      '">' +
      (icon || '') +
      '<p class="cnsl-empty-text">' +
      esc(text) +
      '</p></div>'
    );
  }

  var ICON_CHECK =
    '<svg class="cnsl-empty-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_WARN =
    '<svg class="cnsl-empty-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>';

  /* ------------------------------------------------------------------------
     Fetch
  ------------------------------------------------------------------------ */

  /**
   * One request. Resolves `{ ok, status, data }` or `{ ok:false, error }`.
   * Never throws — a panel's failure must not take the poll cycle down with it.
   */
  function api(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (opts.auth && auth.token) headers.Authorization = 'Bearer ' + auth.token;

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 12000);

    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      mode: 'cors',
    })
      .then(function (res) {
        clearTimeout(timer);
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            return { ok: res.ok, status: res.status, data: data };
          });
      })
      .catch(function (err) {
        clearTimeout(timer);
        return {
          ok: false,
          status: 0,
          error: err && err.name === 'AbortError' ? 'request timed out' : 'network unreachable',
        };
      });
  }

  /** Best-effort extraction of a server-provided message. */
  function errText(res) {
    if (!res) return 'unknown error';
    if (res.error) return res.error;
    var d = res.data;
    if (d && typeof d === 'object') {
      if (typeof d.message === 'string') return d.message;
      if (typeof d.error === 'string') return d.error;
    }
    return 'HTTP ' + res.status;
  }

  /* ------------------------------------------------------------------------
     Toasts
  ------------------------------------------------------------------------ */

  function toast(message, tone) {
    var host = $('toasts');
    var el = document.createElement('div');
    el.className = 'cnsl-toast';
    el.setAttribute('data-tone', tone || '');
    el.innerHTML = '<span class="cnsl-toast-mark"></span><span>' + esc(message) + '</span>';
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 5200);
  }

  /* ------------------------------------------------------------------------
     Connection state
  ------------------------------------------------------------------------ */

  var conn = {
    set: function (state, label) {
      var pill = $('connPill');
      pill.setAttribute('data-state', state);
      $('connLabel').textContent = label;
      var offline = state === 'down';
      $('offlineBanner').classList.toggle('is-visible', offline);
    },
    detail: function (text) {
      $('offlineDetail').textContent = text;
    },
  };

  /* ------------------------------------------------------------------------
     Phase rail
  ------------------------------------------------------------------------ */

  var PHASES = [
    'observe',
    'discover',
    'score',
    'expert_validate',
    'select',
    'source',
    'model_economics',
    'brand',
    'build',
    'qa',
    'launch',
    'market',
    'measure',
    'decide',
    'replan',
  ];

  function renderRail(cycle) {
    var rail = $('phaseRail');
    var idx = cycle ? PHASES.indexOf(cycle.phase) : -1;
    var blocked = Boolean(cycle && (cycle.blockedReason || cycle.blockedOnCapability));

    var html = '';
    for (var i = 0; i < PHASES.length; i++) {
      var state = '';
      if (idx >= 0) {
        if (i < idx) state = 'done';
        else if (i === idx) state = blocked ? 'blocked' : 'active';
      }
      html +=
        '<div class="cnsl-phase" data-state="' +
        state +
        '" title="' +
        esc(humanize(PHASES[i])) +
        '">' +
        '<span class="cnsl-phase-num">' +
        String(i + 1).padStart(2, '0') +
        '</span>' +
        '<span class="cnsl-phase-name">' +
        esc(humanize(PHASES[i])) +
        '</span>' +
        '<span class="cnsl-phase-bar"></span>' +
        '</div>';
    }
    rail.innerHTML = html;

    var note = $('railNote');
    if (!cycle) {
      note.innerHTML = '<span style="color:var(--text-3)">no cycle recorded yet</span>';
    } else {
      note.innerHTML =
        'cycle <strong>#' +
        esc(cycle.cycleNumber !== undefined ? cycle.cycleNumber : cycle.number) +
        '</strong> · phase <strong>' +
        esc(humanize(cycle.phase)) +
        '</strong> · status <strong>' +
        esc(humanize(cycle.status)) +
        '</strong>';
    }

    var blockedHost = $('railBlocked');
    if (blocked) {
      var reason = cycle.blockedReason || 'blocked';
      var cap = cycle.blockedOnCapability;
      blockedHost.innerHTML =
        '<div class="cnsl-rail-blocked"><span class="mono">BLOCKED</span><span>' +
        esc(reason) +
        (cap ? ' <span class="mono" style="color:var(--text-3)">(' + esc(cap) + ')</span>' : '') +
        '</span></div>';
    } else {
      blockedHost.innerHTML = '';
    }
  }

  /* ------------------------------------------------------------------------
     Panels
  ------------------------------------------------------------------------ */

  function setCount(id, value, tone) {
    var el = $(id);
    el.textContent = value === null || value === undefined ? '—' : String(value);
    if (tone) el.setAttribute('data-tone', tone);
    else el.removeAttribute('data-tone');
  }

  function stat(label, value, tone, foot) {
    return (
      '<div class="cnsl-stat">' +
      '<span class="cnsl-stat-label">' +
      esc(label) +
      '</span>' +
      '<span class="cnsl-stat-value"' +
      (tone ? ' data-tone="' + tone + '"' : '') +
      '>' +
      esc(value === null || value === undefined ? '—' : value) +
      '</span>' +
      (foot ? '<span class="cnsl-stat-foot">' + esc(foot) + '</span>' : '') +
      '</div>'
    );
  }

  function renderKpis(s) {
    $('kpiStats').innerHTML =
      stat('Cycle', s.cycle, s.cycle === null ? 'muted' : 'neon', s.cyclePhase) +
      stat(
        'Approvals waiting',
        s.approvals,
        s.approvals > 0 ? 'warn' : s.approvals === 0 ? 'live' : 'muted',
        s.approvals > 0 ? 'needs a human' : 'nothing queued',
      ) +
      stat(
        'Kill switches',
        s.switches,
        s.switches > 0 ? 'danger' : s.switches === 0 ? 'live' : 'muted',
        s.switches > 0 ? 'engaged' : 'all clear',
      ) +
      stat('Agent runs', s.runs, s.runs > 0 ? 'neon' : 'muted', 'active now') +
      stat('Agent spend', s.spend, null, 'last 24h') +
      stat(
        'Capabilities',
        s.caps,
        s.capsTone,
        s.capsFoot,
      ) +
      stat('Orders in flight', s.orders, s.orders > 0 ? 'neon' : 'muted', 'paid → shipped');
  }

  function renderApprovals(res, configured) {
    var body = $('approvalsBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet. POST /api/companies to create one.', '', ICON_WARN);
      setCount('approvalsCount', null);
      return 0;
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load approvals — ' + errText(res), 'danger', ICON_WARN);
      setCount('approvalsCount', null);
      return null;
    }
    var pending = (res.data && res.data.pending) || [];
    setCount('approvalsCount', pending.length, pending.length > 0 ? 'warn' : null);

    if (!pending.length) {
      body.innerHTML = emptyState('Nothing waiting on a human right now.', '', ICON_CHECK);
      return 0;
    }

    var html = '';
    for (var i = 0; i < pending.length; i++) {
      var a = pending[i];
      var amount = money(a.amountMinor, a.currency);
      var when = relTime(a.createdAt);
      var expires = relTime(a.expiresAt);
      html +=
        '<div class="cnsl-row">' +
        '<div class="cnsl-row-main">' +
        '<span class="cnsl-row-title">' +
        esc(a.request || 'approval request') +
        '</span>' +
        '<span class="cnsl-row-meta">' +
        '<span>' +
        esc(a.authority || '—') +
        '</span>' +
        (when ? '<span>opened ' + esc(when) + '</span>' : '') +
        (expires ? '<span>expires ' + esc(expires) + '</span>' : '') +
        (a.subjectRefId ? '<span>' + esc(a.subjectRefId) + '</span>' : '') +
        '</span>' +
        (a.riskNotes
          ? '<span class="cnsl-row-meta" style="color:var(--warn)"><span>' + esc(a.riskNotes) + '</span></span>'
          : '') +
        '</div>' +
        '<div class="cnsl-row-side">' +
        (amount ? '<span class="cnsl-row-amount">' + esc(amount) + '</span>' : '') +
        '<button class="cnsl-act cnsl-act-approve" data-decide="approved" data-id="' +
        esc(a.id) +
        '" data-request="' +
        esc(a.request || '') +
        '"' +
        (auth.unlocked ? '' : ' disabled title="operator token required"') +
        '>Approve</button>' +
        '<button class="cnsl-act cnsl-act-deny" data-decide="rejected" data-id="' +
        esc(a.id) +
        '" data-request="' +
        esc(a.request || '') +
        '"' +
        (auth.unlocked ? '' : ' disabled title="operator token required"') +
        '>Deny</button>' +
        '</div>' +
        '</div>';
    }
    body.innerHTML = html;
    return pending.length;
  }

  function renderSwitches(res, configured) {
    var body = $('switchBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet.', '', ICON_WARN);
      setCount('switchCount', null);
      return 0;
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load kill switches — ' + errText(res), 'danger', ICON_WARN);
      setCount('switchCount', null);
      return null;
    }
    var engaged = (res.data && res.data.engaged) || [];
    var history = (res.data && res.data.history) || [];
    setCount('switchCount', engaged.length, engaged.length > 0 ? 'danger' : null);

    if (!engaged.length) {
      var recent = history.length
        ? 'No scope is currently engaged. ' + history.length + ' historical entr' + (history.length === 1 ? 'y' : 'ies') + '.'
        : 'No scope is currently engaged.';
      body.innerHTML = emptyState(recent, '', ICON_CHECK);
      return 0;
    }

    var html = '';
    for (var i = 0; i < engaged.length; i++) {
      var scope = engaged[i];
      var entry = null;
      for (var j = 0; j < history.length; j++) {
        if (history[j].scope === scope && history[j].engaged) {
          entry = history[j];
          break;
        }
      }
      html +=
        '<div class="cnsl-switch" data-engaged="true">' +
        '<div class="cnsl-switch-main">' +
        '<div class="cnsl-switch-scope">' +
        esc(scope) +
        '</div>' +
        (entry && entry.reason ? '<div class="cnsl-switch-note">' + esc(entry.reason) + '</div>' : '') +
        (entry && entry.engagedBy
          ? '<div class="cnsl-switch-note">by ' + esc(entry.engagedBy) + '</div>'
          : '') +
        '</div>' +
        '<button class="cnsl-act" data-release="' +
        esc(scope) +
        '"' +
        (auth.unlocked ? '' : ' disabled title="operator token required"') +
        '>Release</button>' +
        '</div>';
    }
    body.innerHTML = html;
    return engaged.length;
  }

  function renderBudgets(res, configured) {
    var body = $('budgetBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet.', '', ICON_WARN);
      return;
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load budgets — ' + errText(res), 'danger', ICON_WARN);
      return;
    }
    var budgets = (res.data && res.data.budgets) || [];
    if (!budgets.length) {
      body.innerHTML = emptyState('No budget envelopes defined.', '', ICON_WARN);
      return;
    }

    var html = '';
    for (var i = 0; i < budgets.length; i++) {
      var b = budgets[i];
      var limit = typeof b.limitMinor === 'number' ? b.limitMinor : 0;
      var spent = typeof b.spentMinor === 'number' ? b.spentMinor : 0;
      var reserved = typeof b.reservedMinor === 'number' ? b.reservedMinor : 0;
      var spentPct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
      var resPct = limit > 0 ? Math.min(100 - spentPct, (reserved / limit) * 100) : 0;
      var used = spent + reserved;
      var tone = limit > 0 && used / limit >= 0.9 ? 'danger' : '';

      html +=
        '<div class="cnsl-meter" data-tone="' +
        tone +
        '">' +
        '<div class="cnsl-meter-head">' +
        '<span class="cnsl-meter-name">' +
        esc(humanize(b.scope)) +
        '<span>' +
        esc(b.window || '') +
        (b.hardStop ? ' · hard stop' : '') +
        '</span></span>' +
        '<span class="cnsl-meter-figure">' +
        esc(money(used, b.currency) || '—') +
        ' / ' +
        esc(money(limit, b.currency) || '—') +
        '</span>' +
        '</div>' +
        '<div class="cnsl-meter-track">' +
        '<div class="cnsl-meter-spent" style="width:' +
        spentPct.toFixed(1) +
        '%"></div>' +
        '<div class="cnsl-meter-reserved" style="width:' +
        resPct.toFixed(1) +
        '%"></div>' +
        '</div>' +
        '</div>';
    }
    body.innerHTML = html;
  }

  function renderRuns(res, configured) {
    var body = $('runsBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet.', '', ICON_WARN);
      setCount('runsCount', null);
      $('runsCost').textContent = '—';
      return { active: 0, spend: null };
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load agent runs — ' + errText(res), 'danger', ICON_WARN);
      setCount('runsCount', null);
      $('runsCost').textContent = '—';
      return { active: null, spend: null };
    }

    var active = (res.data && res.data.active) || [];
    var usage = (res.data && res.data.usageLast24h) || [];
    var total = res.data && typeof res.data.totalCostMinorUsd === 'number' ? res.data.totalCostMinorUsd : null;

    setCount('runsCount', active.length, active.length > 0 ? null : null);
    $('runsCost').textContent = total === null ? '—' : (money(total, 'USD') || '—') + ' / 24h';

    var html = '';

    if (active.length) {
      html += '<div style="display:flex;flex-direction:column;gap:9px">';
      for (var i = 0; i < active.length; i++) {
        var r = active[i];
        var started = relTime(r.startedAt);
        html +=
          '<div style="display:flex;align-items:flex-start;gap:10px">' +
          '<span class="cnsl-pill" data-tone="neon">' +
          esc(r.status || 'running') +
          '</span>' +
          '<div class="cnsl-row-main">' +
          '<span class="cnsl-row-title" style="font-size:12.5px">' +
          esc(r.objective || r.roleKey || 'agent run') +
          '</span>' +
          '<span class="cnsl-row-meta">' +
          '<span>' +
          esc(r.roleKey || '—') +
          '</span>' +
          (r.model ? '<span>' + esc(r.model) + '</span>' : '') +
          (started ? '<span>started ' + esc(started) + '</span>' : '') +
          '</span></div></div>';
      }
      html += '</div>';
    } else {
      html +=
        '<p class="cnsl-empty-text" style="text-align:left;max-width:none">No agent run is active right now.</p>';
    }

    if (usage.length) {
      var max = 0;
      for (var k = 0; k < usage.length; k++) {
        if (usage[k].costMinorUsd > max) max = usage[k].costMinorUsd;
      }
      var sorted = usage.slice().sort(function (a, b) {
        return b.costMinorUsd - a.costMinorUsd;
      });
      html +=
        '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">' +
        '<div class="cnsl-stat-label" style="margin-bottom:9px">Spend by role · 24h</div>' +
        '<div class="cnsl-bars">';
      for (var m = 0; m < Math.min(sorted.length, 8); m++) {
        var u = sorted[m];
        var pct = max > 0 ? (u.costMinorUsd / max) * 100 : 0;
        html +=
          '<div class="cnsl-bar-row">' +
          '<span class="cnsl-bar-label" title="' +
          esc(u.roleKey) +
          '">' +
          esc(u.roleKey) +
          '</span>' +
          '<span class="cnsl-bar-track"><span class="cnsl-bar-fill" style="width:' +
          pct.toFixed(1) +
          '%"></span></span>' +
          '<span class="cnsl-bar-value">' +
          esc(money(u.costMinorUsd, 'USD') || '—') +
          '</span>' +
          '</div>';
      }
      html += '</div></div>';
    }

    body.innerHTML = html;
    return { active: active.length, spend: total === null ? null : money(total, 'USD') };
  }

  /** Provider states, mapped to the four tones the design system defines. */
  function providerTone(state) {
    if (state === 'live_verified') return 'live';
    if (state === 'verification_failed') return 'danger';
    if (state === 'blocked_missing_credentials' || state === 'credentials_present_unverified') return 'warn';
    return '';
  }

  function renderProviders(res) {
    var body = $('providerBody');
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load providers — ' + errText(res), 'danger', ICON_WARN);
      setCount('providerCount', null);
      return null;
    }
    var providers = (res.data && res.data.providers) || [];
    var verified = 0;
    for (var v = 0; v < providers.length; v++) {
      if (providers[v].state === 'live_verified') verified++;
    }
    setCount('providerCount', verified + ' / ' + providers.length, verified === providers.length ? null : 'warn');

    if (!providers.length) {
      body.innerHTML = emptyState('No provider manifests returned.', 'warn', ICON_WARN);
      return null;
    }

    // Verified first, then anything actionable, then the rest — an operator
    // scanning this panel is usually looking for what is NOT ready.
    var order = {
      verification_failed: 0,
      blocked_missing_credentials: 1,
      credentials_present_unverified: 2,
      live_verified: 3,
    };
    var sorted = providers.slice().sort(function (a, b) {
      var oa = order[a.state] === undefined ? 4 : order[a.state];
      var ob = order[b.state] === undefined ? 4 : order[b.state];
      if (oa !== ob) return oa - ob;
      return String(a.displayName || a.id).localeCompare(String(b.displayName || b.id));
    });

    var html = '<div class="cnsl-providers">';
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var note = '';
      if (p.state === 'live_verified' && p.lastVerifiedAt) {
        var when = relTime(p.lastVerifiedAt);
        note = when ? 'probe verified ' + when : 'probe verified';
      } else if (p.missingSecrets && p.missingSecrets.length) {
        note = 'missing ' + p.missingSecrets.join(', ');
      } else if (p.malformedSecrets && p.malformedSecrets.length) {
        note = 'malformed ' + p.malformedSecrets.join(', ');
      } else if (p.lastVerificationDetail) {
        note = String(p.lastVerificationDetail);
      } else {
        note = 'awaiting a dated live probe';
      }

      html +=
        '<div class="cnsl-provider" data-state="' +
        esc(p.state || '') +
        '">' +
        '<div class="cnsl-provider-top">' +
        '<span class="cnsl-provider-name">' +
        esc(p.displayName || p.id) +
        '</span>' +
        '<span class="sq ' +
        (p.state === 'live_verified' ? 'sq-live' : 'sq-wired') +
        '" aria-hidden="true"></span>' +
        '</div>' +
        '<span class="cnsl-provider-state">' +
        esc(humanize(p.state)) +
        '</span>' +
        '<span class="cnsl-provider-note">' +
        esc(note) +
        '</span>' +
        '</div>';
    }
    html += '</div>';

    var unimplemented = (res.data && res.data.unimplementedAdapters) || [];
    if (unimplemented.length) {
      html +=
        '<p class="cnsl-provider-note" style="margin-top:11px">' +
        esc(unimplemented.length) +
        ' manifest' +
        (unimplemented.length === 1 ? '' : 's') +
        ' without an adapter factory: ' +
        esc(unimplemented.join(', ')) +
        '</p>';
    }

    body.innerHTML = html;
    return { verified: verified, total: providers.length };
  }

  function orderTone(status) {
    if (status === 'DISPUTED' || status === 'MANUAL_REVIEW') return 'danger';
    if (status === 'PAID') return 'live';
    if (status === 'FULFILLING' || status === 'FULFILLMENT_QUEUED') return 'info';
    return '';
  }

  function renderOrders(res, configured) {
    var body = $('orderBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet.', '', ICON_WARN);
      setCount('orderCount', null);
      return 0;
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load orders — ' + errText(res), 'danger', ICON_WARN);
      setCount('orderCount', null);
      return null;
    }
    var orders = (res.data && res.data.orders) || [];
    setCount('orderCount', orders.length);

    if (!orders.length) {
      body.innerHTML = emptyState('No orders in flight.', '', ICON_CHECK);
      return 0;
    }

    var html = '';
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      html +=
        '<div class="cnsl-row">' +
        '<div class="cnsl-row-main">' +
        '<span class="cnsl-row-title" style="font-size:12.5px">' +
        esc(o.orderNumber || o.id) +
        '</span>' +
        '<span class="cnsl-row-meta">' +
        (relTime(o.createdAt) ? '<span>' + esc(relTime(o.createdAt)) + '</span>' : '') +
        (o.riskLevel ? '<span>risk ' + esc(o.riskLevel) + '</span>' : '') +
        '</span>' +
        (o.manualReviewReason
          ? '<span class="cnsl-row-meta" style="color:var(--warn)"><span>' +
            esc(o.manualReviewReason) +
            '</span></span>'
          : '') +
        '</div>' +
        '<div class="cnsl-row-side" style="flex-direction:column;align-items:flex-end;gap:5px">' +
        '<span class="cnsl-pill" data-tone="' +
        orderTone(o.status) +
        '">' +
        esc(o.status) +
        '</span>' +
        '<span class="cnsl-row-amount" style="font-size:11.5px">' +
        esc(money(o.totalMinor, o.currency) || '—') +
        '</span>' +
        '</div></div>';
    }
    body.innerHTML = html;
    return orders.length;
  }

  function renderAudit(res, configured) {
    var body = $('auditBody');
    if (!configured) {
      body.innerHTML = emptyState('No company configured yet.', '', ICON_WARN);
      setCount('auditCount', null);
      return;
    }
    if (!res.ok) {
      body.innerHTML = emptyState('Could not load the audit log — ' + errText(res), 'danger', ICON_WARN);
      setCount('auditCount', null);
      return;
    }
    var events = (res.data && res.data.events) || [];
    setCount('auditCount', events.length);

    if (!events.length) {
      body.innerHTML = emptyState('No audit events recorded yet.', '', ICON_CHECK);
      return;
    }

    var html = '';
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var hash = e.hash ? String(e.hash) : '';
      var shortHash = hash ? hash.slice(0, 4) + '…' + hash.slice(-3) : '—';
      var amount = money(e.amountMinor, e.currency);
      html +=
        '<div class="cnsl-audit-row">' +
        '<span class="cnsl-audit-pos">#' +
        esc(String(e.position).padStart(4, '0')) +
        '</span>' +
        '<span class="cnsl-audit-hash">' +
        esc(shortHash) +
        '</span>' +
        '<span class="cnsl-audit-action">' +
        esc(e.action || e.kind) +
        (amount ? ' <span style="color:var(--text-3)">· ' + esc(amount) + '</span>' : '') +
        '</span>' +
        '<span class="cnsl-audit-time">' +
        esc(e.actorKind === 'human_operator' ? 'human' : e.actorKind || '') +
        ' · ' +
        esc(relTime(e.occurredAt) || '—') +
        '</span>' +
        '</div>';
    }
    body.innerHTML = html;
  }

  /* ------------------------------------------------------------------------
     Poll
  ------------------------------------------------------------------------ */

  var polling = false;

  function poll() {
    if (polling) return Promise.resolve();
    polling = true;
    $('refreshBtn').classList.add('is-spinning');
    if ($('connPill').getAttribute('data-state') !== 'down') conn.set('polling', 'reading');

    return api('/readiness/company')
      .then(function (companyRes) {
        if (!companyRes.ok && companyRes.status === 0) {
          // Genuine unreachability. Everything else is a real API answer.
          conn.set('down', 'unreachable');
          conn.detail(companyRes.error === 'request timed out' ? 'The API timed out.' : 'The API did not respond.');
          return null;
        }

        var configured = Boolean(companyRes.ok && companyRes.data && companyRes.data.configured);

        if (companyRes.ok) {
          conn.set('ok', 'connected');
        } else {
          conn.set('down', 'HTTP ' + companyRes.status);
          conn.detail('The API answered with HTTP ' + companyRes.status + '.');
        }

        // Headline + rail come straight from /readiness/company.
        if (configured) {
          var c = companyRes.data.company || {};
          $('companyName').textContent = c.name || 'Operator console';
          $('stageValue').textContent = c.stage ? humanize(c.stage) : '—';
          $('companySub').textContent =
            'Live state for ' + (c.name || 'this company') + '. Every figure is read from the running API.';
        } else if (companyRes.ok) {
          $('companyName').textContent = 'No company configured';
          $('stageValue').textContent = 'none';
          $('companySub').textContent =
            (companyRes.data && companyRes.data.message) ||
            'No company has been created yet. POST /api/companies to configure one.';
        }

        var cycles = (companyRes.ok && companyRes.data && companyRes.data.loop) || [];
        renderRail(cycles.length ? cycles[0] : null);

        // Everything else, in parallel. A failure in one panel is contained
        // to that panel.
        return Promise.all([
          api('/api/approvals'),
          api('/api/kill-switches'),
          api('/api/budgets'),
          api('/api/agent-runs'),
          api('/readiness/providers'),
          api('/api/orders'),
          api('/api/audit?limit=' + AUDIT_LIMIT),
          api('/readiness/capabilities'),
        ]).then(function (r) {
          var approvals = renderApprovals(r[0], configured);
          var switches = renderSwitches(r[1], configured);
          renderBudgets(r[2], configured);
          var runs = renderRuns(r[3], configured);
          var providers = renderProviders(r[4]);
          var orders = renderOrders(r[5], configured);
          renderAudit(r[6], configured);

          var caps = null;
          var capsTone = 'muted';
          var capsFoot = 'not read';
          if (r[7].ok && r[7].data && r[7].data.summary) {
            var sum = r[7].data.summary;
            caps = sum.liveVerified + ' / ' + sum.total;
            capsTone = sum.liveVerified === sum.total ? 'live' : 'warn';
            capsFoot = r[7].data.fullyVerified ? 'all live-verified' : 'not fully verified';
          }

          renderKpis({
            cycle: cycles.length ? '#' + (cycles[0].cycleNumber !== undefined ? cycles[0].cycleNumber : cycles[0].number) : null,
            cyclePhase: cycles.length ? humanize(cycles[0].phase) : 'no cycle yet',
            approvals: approvals,
            switches: switches,
            runs: runs.active,
            spend: runs.spend,
            caps: caps,
            capsTone: capsTone,
            capsFoot: capsFoot,
            orders: orders,
          });

          $('updatedAt').textContent = 'updated ' + new Date().toLocaleTimeString();
        });
      })
      .then(function () {
        polling = false;
        $('refreshBtn').classList.remove('is-spinning');
      })
      .catch(function () {
        polling = false;
        $('refreshBtn').classList.remove('is-spinning');
        conn.set('down', 'error');
      });
  }

  /* ------------------------------------------------------------------------
     Actions
  ------------------------------------------------------------------------ */

  var decideTarget = null;

  function openDecide(id, request, decision) {
    if (!auth.unlocked) {
      openToken();
      return;
    }
    // The server requires `decidedBy` to be at least 3 characters. Checking it
    // here turns a 400 into an instruction.
    if (!auth.operator || auth.operator.length < 3) {
      toast('Set a name of at least 3 characters — it is recorded as the deciding actor.', 'error');
      openToken();
      return;
    }
    decideTarget = { id: id, decision: decision };
    $('decideModalTitle').textContent = decision === 'approved' ? 'Approve request' : 'Deny request';
    $('decideSubject').textContent = request || id;
    $('decideConfirmBtn').textContent = decision === 'approved' ? 'Approve' : 'Deny';
    $('rationaleInput').value = '';
    $('decideNote').textContent =
      'Recorded as ' + auth.operator + ' in the append-only audit chain. This cannot be undone.';
    $('decideModal').classList.add('is-open');
    setTimeout(function () {
      $('rationaleInput').focus();
    }, 60);
  }

  function submitDecision() {
    if (!decideTarget) return;
    var rationale = $('rationaleInput').value.trim();
    if (rationale.length < 3) {
      toast('A rationale of at least 3 characters is required — it goes into the audit chain.', 'error');
      return;
    }
    var btn = $('decideConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    api('/api/approvals/' + encodeURIComponent(decideTarget.id) + '/decide', {
      method: 'POST',
      auth: true,
      body: { decision: decideTarget.decision, decidedBy: auth.operator, rationale: rationale },
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = decideTarget && decideTarget.decision === 'approved' ? 'Approve' : 'Deny';
      if (res.ok) {
        toast('Approval ' + (decideTarget.decision === 'approved' ? 'granted' : 'rejected') + '.', 'ok');
        $('decideModal').classList.remove('is-open');
        decideTarget = null;
        poll();
      } else if (res.status === 401 || res.status === 403) {
        toast('Rejected: the operator token was not accepted.', 'error');
      } else {
        toast('Failed: ' + errText(res), 'error');
      }
    });
  }

  function releaseSwitch(scope) {
    if (!auth.unlocked) {
      openToken();
      return;
    }
    if (!auth.operator || auth.operator.length < 3) {
      toast('Set a name of at least 3 characters — it is recorded as the releasing actor.', 'error');
      openToken();
      return;
    }
    if (!window.confirm('Release the "' + scope + '" kill switch? Work in that scope resumes immediately.')) return;

    api('/api/kill-switches/' + encodeURIComponent(scope) + '/release', {
      method: 'POST',
      auth: true,
      body: { releasedBy: auth.operator },
    }).then(function (res) {
      if (res.ok) {
        toast('Released ' + scope + '.', 'ok');
        poll();
      } else if (res.status === 401 || res.status === 403) {
        toast('Rejected: the operator token was not accepted.', 'error');
      } else {
        toast('Failed: ' + errText(res), 'error');
      }
    });
  }

  function verifyChain() {
    var btn = $('verifyChainBtn');
    var pill = $('chainPill');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    pill.textContent = 'verifying…';
    pill.removeAttribute('data-tone');

    api('/api/audit/verify').then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Verify chain';
      if (res.status === 0) {
        pill.textContent = 'could not reach the API';
        pill.setAttribute('data-tone', 'danger');
        return;
      }
      var valid = res.ok && res.data && res.data.valid;
      if (valid) {
        var count = res.data.count !== undefined ? res.data.count : null;
        pill.textContent = 'chain verified' + (count !== null ? ' · ' + count + ' events' : '');
        pill.setAttribute('data-tone', 'live');
        toast('Audit chain verified — every hash recomputed.', 'ok');
      } else {
        pill.textContent = 'chain INVALID';
        pill.setAttribute('data-tone', 'danger');
        toast('Audit chain verification failed. ' + errText(res), 'error');
      }
    });
  }

  /* ------------------------------------------------------------------------
     Token modal
  ------------------------------------------------------------------------ */

  function syncTokenButton() {
    var btn = $('tokenBtn');
    btn.setAttribute('data-state', auth.unlocked ? 'unlocked' : 'locked');
    btn.title = auth.unlocked ? 'Operator token set — ' + (auth.operator || 'unnamed') : 'Operator token not set';
    var shackle = document.getElementById('shackle');
    if (shackle) shackle.setAttribute('d', auth.unlocked ? 'M8 10.5V7a4 4 0 0 1 7.5-2' : 'M8 10.5V7a4 4 0 0 1 8 0v3.5');
    var pill = $('approvalsAuth');
    if (auth.unlocked) {
      pill.textContent = 'deciding as ' + (auth.operator || 'unnamed');
      pill.setAttribute('data-tone', 'neon');
    } else {
      pill.textContent = 'token required to decide';
      pill.removeAttribute('data-tone');
    }
  }

  function openToken() {
    $('tokenInput').value = auth.token || '';
    $('operatorInput').value = auth.operator || '';
    $('tokenModal').classList.add('is-open');
    setTimeout(function () {
      $(auth.token ? 'operatorInput' : 'tokenInput').focus();
    }, 60);
  }

  /* ------------------------------------------------------------------------
     Wiring
  ------------------------------------------------------------------------ */

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-decide],[data-release]') : null;
    if (!t) return;
    if (t.hasAttribute('data-decide')) {
      openDecide(t.getAttribute('data-id'), t.getAttribute('data-request'), t.getAttribute('data-decide'));
    } else if (t.hasAttribute('data-release')) {
      releaseSwitch(t.getAttribute('data-release'));
    }
  });

  $('refreshBtn').addEventListener('click', function () {
    poll();
  });
  $('verifyChainBtn').addEventListener('click', verifyChain);
  $('tokenBtn').addEventListener('click', openToken);

  $('tokenSaveBtn').addEventListener('click', function () {
    auth.save($('tokenInput').value.trim(), $('operatorInput').value.trim());
    syncTokenButton();
    $('tokenModal').classList.remove('is-open');
    toast(auth.unlocked ? 'Operator token stored for this tab.' : 'Operator token cleared.', 'ok');
    poll();
  });
  $('tokenClearBtn').addEventListener('click', function () {
    auth.save(null, null);
    syncTokenButton();
    $('tokenModal').classList.remove('is-open');
    toast('Operator token cleared.', 'ok');
    poll();
  });
  $('tokenCancelBtn').addEventListener('click', function () {
    $('tokenModal').classList.remove('is-open');
  });
  $('decideCancelBtn').addEventListener('click', function () {
    $('decideModal').classList.remove('is-open');
    decideTarget = null;
  });
  $('decideConfirmBtn').addEventListener('click', submitDecision);

  // Backdrop click and Escape both close.
  ['tokenModal', 'decideModal'].forEach(function (id) {
    $(id).addEventListener('click', function (ev) {
      if (ev.target === this) this.classList.remove('is-open');
    });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      $('tokenModal').classList.remove('is-open');
      $('decideModal').classList.remove('is-open');
    }
    // `r` refreshes, unless the operator is typing.
    if (ev.key === 'r' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) poll();
  });

  /* Reveal on entry — matches the landing page, at lower amplitude. */
  var reveal = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          reveal.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -40px 0px', threshold: 0.05 },
  );
  document.querySelectorAll('[data-c-reveal]').forEach(function (el) {
    reveal.observe(el);
  });

  /* ------------------------------------------------------------------------
     Boot
  ------------------------------------------------------------------------ */

  $('apiBaseLabel').textContent = API;
  $('pollLabel').textContent = String(POLL_MS / 1000);
  syncTokenButton();

  // Skeletons, so the first paint reads as "not yet known" rather than "empty".
  ['approvalsBody', 'switchBody', 'budgetBody', 'runsBody', 'providerBody', 'orderBody', 'auditBody'].forEach(
    function (id) {
      $(id).innerHTML = skeleton(3);
    },
  );
  renderRail(null);

  poll();

  // Polling pauses while the tab is hidden: a backgrounded console does not
  // need to burn the API's 300/min rate limit.
  var timer = setInterval(function () {
    if (!document.hidden) poll();
  }, POLL_MS);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  window.addEventListener('beforeunload', function () {
    clearInterval(timer);
  });
})();
