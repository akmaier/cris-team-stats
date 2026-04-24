/*
 * cris-team-stats
 *
 * Build a sortable table of research output for every member of an FAU
 * team/person listing page, by pulling live data from FAU CRIS.
 *
 * Usage:
 *   <div id="out"></div>
 *   <script src="https://cdn.jsdelivr.net/gh/akmaier/cris-team-stats@main/cris-team-stats.js"></script>
 *   <script>
 *     CrisTeamStats.run({
 *       teamUrl: 'https://lme.tf.fau.de/person/',
 *       mount:   '#out',
 *       mapping: { 'andreas-maier': 101449090 },
 *       proxyTpl:'https://api.allorigins.win/get?url={URL}',
 *     });
 *   </script>
 */

(function (root, factory) {
  root.CrisTeamStats = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Public CORS proxies are flaky; we try a list in order and fall back on
  // HTTP errors or network failures. Override via `proxyTpl` (string, array
  // of strings, or array of {url, headers}) when calling `run(...)`.
  //
  // Why jina first? It handles URLs with query strings (like CRIS /search)
  // reliably, whereas codetabs / corsproxy get confused by the double '?'.
  // The X-Return-Format header asks jina to return raw HTML rather than its
  // default markdown rendering.
  const DEFAULT_PROXIES = [
    { url: 'https://r.jina.ai/{URL_RAW}', headers: { 'X-Return-Format': 'html' } },
    'https://api.allorigins.win/get?url={URL}',
    'https://api.codetabs.com/v1/proxy/?quest={URL_RAW}',
    'https://corsproxy.io/?{URL_RAW}',
  ];

  /* ---------- CORS-proxy aware fetcher ---------- */
  // Expands a template. {URL} → URL-encoded; {URL_RAW} → raw URL.
  function expandProxy(tpl, url) {
    return tpl.replace('{URL}', encodeURIComponent(url)).replace('{URL_RAW}', url);
  }
  function normaliseProxy(p) {
    return typeof p === 'string' ? { url: p, headers: undefined } : p;
  }
  async function fetchTextOnce(url, proxy) {
    const { url: tpl, headers } = normaliseProxy(proxy);
    const proxied = expandProxy(tpl, url);
    const res = await fetch(proxied, { cache: 'no-store', headers });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' via ' + tpl);
    const ct = res.headers.get('Content-Type') || '';
    const body = await res.text();
    // allorigins.win/get wraps in JSON; detect and unwrap.
    if (tpl.includes('/get?') && (ct.includes('application/json') || body.trimStart().startsWith('{'))) {
      try {
        const env = JSON.parse(body);
        if (env && typeof env.contents === 'string') return env.contents;
      } catch (_) { /* fall through */ }
    }
    return body;
  }
  async function fetchText(url, proxyTpl) {
    const tpls = Array.isArray(proxyTpl) ? proxyTpl
               : proxyTpl              ? [proxyTpl]
                                        : DEFAULT_PROXIES;
    const errors = [];
    for (const tpl of tpls) {
      try { return await fetchTextOnce(url, tpl); }
      catch (e) {
        const tplUrl = normaliseProxy(tpl).url;
        const short = tplUrl.replace(/^https?:\/\//, '').split('/')[0];
        errors.push(short + ': ' + (e.message || e));
      }
    }
    throw new Error('All ' + tpls.length + ' CORS proxy attempt(s) failed for ' + url + ' [' + errors.join(' | ') + ']');
  }

  /* ---------- FAU team-page parser ---------- */
  // Accepts the HTML of a team listing page; returns { name, slug, url }[].
  function parseTeamPage(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = new URL(baseUrl);
    const seen = new Map();
    const rx = /\/(persons|our-team)\/([^\/\?#]+)\/?$/;
    doc.querySelectorAll('a[href]').forEach((a) => {
      let href;
      try { href = new URL(a.getAttribute('href'), baseUrl).toString(); }
      catch (_) { return; }
      const u = new URL(href);
      if (u.host !== base.host) return;
      const m = u.pathname.match(rx);
      if (!m) return;
      const slug = m[2];
      if (slug === 'person' || slug === 'persons' || slug === 'our-team') return;
      const name = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!name || name.length < 3) return;
      // Prefer the first occurrence (usually the link on the image / name row).
      if (!seen.has(slug)) seen.set(slug, { name, slug, url: href });
    });
    return Array.from(seen.values());
  }

  /* ---------- CRIS profile parser ---------- */
  // Reads counts out of the `<ul tabs>` block and the personal-website link.
  function parseProfilePage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = {
      publications:       0,
      projectLeads:       0,
      projectMemberships: 0,
      awards:             0,
      datasets:           0,
      activities:         0,
      personalWebsite:    null,
      heading:            null,
    };
    const h1 = doc.querySelector('h1');
    if (h1) out.heading = h1.textContent.trim();

    doc.querySelectorAll('ul[tabs] li, ul tabs li, ul[tabs] > a > li').forEach((li) => {
      const top = li.querySelector('.tab-top');
      const bot = li.querySelector('.tab-bottom');
      if (!top || !bot) return;
      const label = top.textContent.trim().toLowerCase();
      const num = parseInt((bot.textContent || '').replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(num)) return;
      if (label.startsWith('publication'))          out.publications       = num;
      else if (label.startsWith('project lead'))    out.projectLeads       = num;
      else if (label.startsWith('project member'))  out.projectMemberships = num;
      else if (label.startsWith('award'))           out.awards             = num;
      else if (label.startsWith('research data'))   out.datasets           = num;
      else if (label.startsWith('activit'))         out.activities         = num;
    });

    // "Personal Website" link — used to verify the mapping.
    doc.querySelectorAll('div.person-link').forEach((d) => {
      const s = d.querySelector('strong');
      if (!s) return;
      if (/personal website/i.test(s.textContent)) {
        const a = d.querySelector('a[href]');
        if (a) out.personalWebsite = a.getAttribute('href');
      }
    });

    return out;
  }

  /* ---------- BibTeX parser (count-oriented, not a full AST) ---------- */
  // We only need: entry type, year, and the author list (in order). Good
  // enough for counting journals / conferences / first-authors, even for
  // messy FAU entries with escaped braces.
  function parseBibtex(bibtex) {
    const entries = [];
    // Walk entries by scanning '@xxx{' starts and matching braces.
    // Non-entry directives (@comment, @string, @preamble) are skipped.
    const SKIP = new Set(['comment', 'string', 'preamble']);
    let i = 0;
    const n = bibtex.length;
    while (i < n) {
      const at = bibtex.indexOf('@', i);
      if (at < 0) break;
      const brace = bibtex.indexOf('{', at);
      if (brace < 0) break;
      const type = bibtex.slice(at + 1, brace).trim().toLowerCase();
      // Match the outer { ... } to find the entry end.
      let depth = 1, j = brace + 1;
      while (j < n && depth > 0) {
        const c = bibtex[j];
        if (c === '{')      depth++;
        else if (c === '}') depth--;
        j++;
      }
      if (depth !== 0) break;
      const body = bibtex.slice(brace + 1, j - 1);
      if (!SKIP.has(type)) entries.push({ type, body });
      i = j;
    }

    function field(body, name) {
      // Match "<name> = {...}" with possibly-nested braces, OR "<name> = "quoted""
      const rx = new RegExp('\\b' + name + '\\s*=\\s*', 'i');
      const m = body.match(rx);
      if (!m) return null;
      let k = m.index + m[0].length;
      if (body[k] === '{') {
        let depth = 1, s = k + 1;
        while (s < body.length && depth > 0) {
          const c = body[s];
          if (c === '{')      depth++;
          else if (c === '}') depth--;
          s++;
        }
        return body.slice(k + 1, s - 1);
      }
      if (body[k] === '"') {
        const end = body.indexOf('"', k + 1);
        return end < 0 ? null : body.slice(k + 1, end);
      }
      // Bare numeric (e.g. year = 2020, )
      const bare = body.slice(k).match(/^[^,\n\r}]+/);
      return bare ? bare[0].trim() : null;
    }

    // author = {Last1, First1 and Last2, First2 and ...}
    function splitAuthors(raw) {
      if (!raw) return [];
      return raw.split(/\s+and\s+/i).map((s) => s.replace(/[{}]/g, '').trim()).filter(Boolean);
    }

    const rows = entries.map((e) => {
      const authorsRaw = field(e.body, 'author');
      const yearRaw    = field(e.body, 'year');
      const year = yearRaw ? parseInt(yearRaw.replace(/[^\d]/g, ''), 10) : null;
      return {
        type: e.type,
        authors: splitAuthors(authorsRaw),
        year: Number.isFinite(year) ? year : null,
      };
    });

    return rows;
  }

  /* ---------- Matching a CRIS author string to a person ---------- */
  // CRIS BibTeX uses "Last, First Middle" and sometimes "First Last". We
  // normalise both the search name and the candidate to lower-case
  // last-name tokens.
  // Common German academic-title prefixes seen on FAU pages.
  const TITLE_RX = /\b(prof|priv|pd|apl|univ|em|emer|emeritus|hon|dr|ing|phil|rer|nat|med|habil|mult|hc|h\.c|dipl|msc|m\.sc|bsc|b\.sc|ph\.d|phd|mag|ma|ba|dr\.-ing|drmed|drphil|drrerpol|drrernat|drrernatmed)\b\.?/gi;
  // Titles that split into multiple tokens after punctuation normalisation:
  // "M. Sc." → "M Sc", "Ph. D." → "Ph D", "h.c." → "h c", etc.
  const SPLIT_TITLE_RX = /\b(m\s*sc|b\s*sc|m\s*a|b\s*a|ph\s*d|h\s*c|dr\s*ing|dr\s*med|dr\s*phil|dr\s*rer|rer\s*nat|rer\s*pol|habil|em|emer|emeritus|honoris\s*causa)\b/gi;
  function normaliseName(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
      .replace(TITLE_RX, ' ')                   // strip titles WITH their dots
      .replace(/[^\p{L}\s,]/gu, ' ')            // drop remaining punctuation (keep comma)
      .replace(SPLIT_TITLE_RX, ' ')             // catch M Sc / Ph D / h c / dr ing etc.
      .replace(TITLE_RX, ' ')                   // one more pass
      .replace(/\s+,\s+/g, ', ')                // compact commas
      .replace(/\s+/g, ' ')
      .replace(/,\s*$/, '')                     // trailing "," (from stripped suffix titles)
      .trim();
  }
  // Split into (last, first). Handles both "Last, First" and "First Last".
  // A bare comma with nothing after it means the suffix was a stripped title
  // (e.g. "Marcel Dreier, M. Sc." → "marcel dreier") — treat as space form.
  function splitName(n) {
    n = normaliseName(n);
    if (!n) return { last: '', first: '' };
    if (n.includes(',')) {
      const [left, right = ''] = n.split(',', 2).map((s) => s.trim());
      if (right) {
        return { last: left, first: right.split(' ').filter(Boolean)[0] || '' };
      }
      // Comma at end — fall through to space-separated form.
      n = left;
    }
    const parts = n.split(' ').filter(Boolean);
    return {
      last:  parts[parts.length - 1] || '',
      first: parts.length > 1 ? parts[0] : '',
    };
  }
  function lastNameOf(n)  { return splitName(n).last; }
  function firstNameOf(n) { return splitName(n).first; }
  function nameMatches(bibAuthor, person) {
    const bln = lastNameOf(bibAuthor);
    const bfn = firstNameOf(bibAuthor);
    const pln = lastNameOf(person);
    const pfn = firstNameOf(person);
    if (!bln || !pln) return false;
    if (bln !== pln) return false;
    // First name may be initialised on one side; accept any initial match.
    if (!bfn || !pfn) return true;
    if (bfn === pfn) return true;
    return bfn[0] === pfn[0];
  }

  /* ---------- Compute a row ---------- */
  function computeStats(bibEntries, profile, displayName) {
    let journals = 0, conferences = 0, other = 0, firstAuthored = 0;
    let minYear = null, maxYear = null;
    for (const e of bibEntries) {
      if (e.type === 'article')                               journals++;
      else if (e.type === 'inproceedings' || e.type === 'conference') conferences++;
      else                                                    other++;
      if (e.year) {
        if (minYear == null || e.year < minYear) minYear = e.year;
        if (maxYear == null || e.year > maxYear) maxYear = e.year;
      }
      if (e.authors.length && nameMatches(e.authors[0], displayName)) firstAuthored++;
    }
    const total = journals + conferences + other;
    const currentYear = new Date().getFullYear();
    const yearsAtFau = minYear ? Math.max(1, currentYear - minYear + 1) : 0;
    const pubsPerYear = yearsAtFau ? (total / yearsAtFau) : 0;
    return {
      total,
      journals,
      conferences,
      other,
      firstAuthored,
      projects: (profile.projectLeads || 0) + (profile.projectMemberships || 0),
      firstYear: minYear,
      lastYear: maxYear,
      yearsAtFau,
      pubsPerYear,
    };
  }

  /* ---------- Name -> CRIS-ID auto-discovery ---------- */
  // CRIS exposes a public full-text search at /search?query=... that returns
  // an HTML page with result cards. We extract every /persons/{ID} link and
  // return them in document order (which is relevance-ranked).
  // Strip titles but keep original case so the search query reads naturally
  // (e.g. "Prof. Dr.-Ing. Andreas Maier" -> "Andreas Maier"). CRIS search
  // is intolerant of the title fluff.
  function cleanQueryName(full) {
    // Keep diacritics: CRIS stores names with umlauts (e.g. Nöth) and the
    // search index matches exact characters. We only strip titles +
    // punctuation, not letter accents.
    return (full || '')
      .replace(TITLE_RX, ' ')              // titles with their dots intact
      .replace(/[^\p{L}\s]/gu, ' ')        // punctuation → space
      .replace(SPLIT_TITLE_RX, ' ')        // catch titles that split on punctuation
      .replace(TITLE_RX, ' ')              // one more pass
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function searchCrisIds(fullName, proxyTpl) {
    const q = cleanQueryName(fullName);
    if (!q) return [];
    const url = 'https://cris.fau.de/search?query=' + encodeURIComponent(q);
    let html;
    try { html = await fetchText(url, proxyTpl); }
    catch (_) { return []; }
    const ids = [];
    const seen = new Set();
    const rx = /\/persons\/(\d+)\/?/g;
    let m;
    while ((m = rx.exec(html)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    }
    return ids;
  }

  // Pick the first candidate whose CRIS profile's "Personal Website" link
  // shares a host with the FAU person URL (and ideally has a matching name).
  // Falls back to the first candidate if no verifier matches, so the user
  // still gets a row to review.
  async function discoverCrisId(person, proxyTpl) {
    const ids = await searchCrisIds(person.name, proxyTpl);
    if (!ids.length) return { id: null, confidence: 'none', candidates: [] };
    let fauHost;
    try { fauHost = new URL(person.url).host; } catch (_) { fauHost = null; }
    // Try all candidates. Prefer "high" (name+host match) over "name-only".
    // The first candidate is the relevance-ranked best guess.
    const MAX = Math.min(6, ids.length);
    let fallback = null;
    for (let i = 0; i < MAX; i++) {
      const id = ids[i];
      try {
        const profHtml = await fetchText('https://cris.fau.de/persons/' + id + '/', proxyTpl);
        const prof = parseProfilePage(profHtml);
        const nameOk = prof.heading && nameMatches(prof.heading, person.name);
        let hostOk = false;
        if (prof.personalWebsite && fauHost) {
          try { hostOk = new URL(prof.personalWebsite).host === fauHost; } catch (_) {}
        }
        if (nameOk && hostOk) return { id, confidence: 'high', candidates: ids };
        if (nameOk && !fallback) fallback = { id, confidence: 'name-only', candidates: ids };
      } catch (_) { /* try next */ }
    }
    if (fallback) return fallback;
    return { id: ids[0], confidence: 'guess', candidates: ids };
  }

  /* ---------- High-level orchestration for one person ---------- */
  async function loadPerson(person, crisId, proxyTpl) {
    const profileUrl = 'https://cris.fau.de/persons/' + crisId + '/';
    const bibUrl     = 'https://cris.fau.de/bibtex/person/' + crisId + '.bib';
    const [profHtml, bib] = await Promise.all([
      fetchText(profileUrl, proxyTpl),
      fetchText(bibUrl,     proxyTpl),
    ]);
    const profile = parseProfilePage(profHtml);
    const entries = parseBibtex(bib);
    const stats   = computeStats(entries, profile, person.name);
    return { person, crisId, profile, stats, profileUrl };
  }

  /* ---------- Table rendering (sortable) ---------- */
  const COLUMNS = [
    { key: 'name',          label: 'Name',           kind: 'str'  },
    { key: 'cris',          label: 'CRIS',           kind: 'str', sortable: false },
    { key: 'journals',      label: 'Journal',        kind: 'num'  },
    { key: 'conferences',   label: 'Conf.',          kind: 'num'  },
    { key: 'firstAuthored', label: '1st author',     kind: 'num'  },
    { key: 'projects',      label: 'Projects',       kind: 'num'  },
    { key: 'total',         label: 'Total pubs',     kind: 'num'  },
    { key: 'firstYear',     label: 'First pub',      kind: 'num'  },
    { key: 'yearsAtFau',    label: 'Years @ FAU',    kind: 'num'  },
    { key: 'pubsPerYear',   label: 'Pubs / yr',      kind: 'num'  },
  ];

  function rowValue(row, key) {
    if (key === 'name') return row.person.name;
    if (key === 'cris') return row.crisId || '';
    return (row.stats && row.stats[key] != null) ? row.stats[key] : null;
  }

  function renderTable(container, rows, state) {
    state = state || { sortKey: 'total', dir: -1 };
    container.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'cris-team-stats';
    const thead = document.createElement('thead');
    const trh   = document.createElement('tr');
    COLUMNS.forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.sortable !== false) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
          if (state.sortKey === c.key) state.dir = -state.dir;
          else { state.sortKey = c.key; state.dir = c.kind === 'num' ? -1 : 1; }
          renderTable(container, rows, state);
        });
        if (state.sortKey === c.key) th.textContent += state.dir < 0 ? ' ▾' : ' ▴';
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const sorted = rows.slice().sort((a, b) => {
      const va = rowValue(a, state.sortKey);
      const vb = rowValue(b, state.sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return state.dir * (va - vb);
      return state.dir * String(va).localeCompare(String(vb));
    });

    const tbody = document.createElement('tbody');
    sorted.forEach((row) => {
      const tr = document.createElement('tr');
      tr.dataset.slug = row.person.slug;
      if (row.error) tr.classList.add('error');
      if (row.warn)  tr.classList.add('warn');
      COLUMNS.forEach((c) => {
        const td = document.createElement('td');
        if (c.key === 'name') {
          const a = document.createElement('a');
          a.href = row.person.url;
          a.textContent = row.person.name;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          td.appendChild(a);
          if (row.error) {
            const em = document.createElement('em');
            em.textContent = ' — ' + row.error;
            em.style.color = '#a00';
            td.appendChild(em);
          } else if (row.warn) {
            const em = document.createElement('em');
            em.textContent = ' — ' + row.warn;
            em.style.color = '#a60';
            td.appendChild(em);
          }
        } else if (c.key === 'cris') {
          if (row.crisId) {
            const a = document.createElement('a');
            a.href = row.profileUrl || ('https://cris.fau.de/persons/' + row.crisId + '/');
            a.textContent = row.crisId;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            td.appendChild(a);
            if (row.confidence && row.confidence !== 'high') {
              const em = document.createElement('em');
              em.textContent = ' (' + row.confidence + ')';
              em.style.color = '#a60';
              em.title = 'Auto-discovered; verify manually';
              td.appendChild(em);
            }
          } else if (row.discovering) {
            const span = document.createElement('span');
            span.textContent = 'searching…';
            span.className = 'muted';
            span.style.color = '#888';
            td.appendChild(span);
          } else {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.placeholder = 'CRIS ID';
            inp.style.width = '8em';
            inp.addEventListener('change', () => {
              const v = inp.value.trim();
              if (v) {
                row.crisId = v;
                if (typeof state.onIdEntered === 'function') state.onIdEntered(row);
              }
            });
            td.appendChild(inp);
          }
        } else if (c.key === 'pubsPerYear') {
          const v = rowValue(row, c.key);
          td.textContent = (typeof v === 'number' && v > 0) ? v.toFixed(2) : '';
        } else {
          const v = rowValue(row, c.key);
          td.textContent = v == null ? '' : String(v);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  /* ---------- Minimal stylesheet (injected once) ---------- */
  function injectStyle() {
    if (document.getElementById('cris-team-stats-style')) return;
    const s = document.createElement('style');
    s.id = 'cris-team-stats-style';
    s.textContent = `
      table.cris-team-stats { border-collapse: collapse; margin: 1em 0; font-size: 0.95em; }
      table.cris-team-stats th, table.cris-team-stats td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
      table.cris-team-stats th { background: #f4f4f4; user-select: none; }
      table.cris-team-stats tr.error { background: #fee; }
      table.cris-team-stats tr.warn  { background: #ffd; }
      table.cris-team-stats a { text-decoration: none; color: #04316a; }
      table.cris-team-stats a:hover { text-decoration: underline; }
    `;
    document.head.appendChild(s);
  }

  /* ---------- End-to-end driver ---------- */
  async function run(opts) {
    const teamUrl  = opts.teamUrl  || 'https://lme.tf.fau.de/person/';
    const proxyTpl = opts.proxyTpl;  // undefined → fetchText uses DEFAULT_PROXIES
    const mount    = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
    const mapping  = opts.mapping  || {};
    if (!mount) throw new Error('cris-team-stats: mount element not found');
    injectStyle();

    mount.innerHTML = '<p><em>Loading team page&hellip;</em></p>';
    let html;
    try { html = await fetchText(teamUrl, proxyTpl); }
    catch (e) { mount.innerHTML = '<p style="color:#a00">Failed to load team page: ' + e.message + '</p>'; return; }

    const people = parseTeamPage(html, teamUrl);
    if (!people.length) { mount.innerHTML = '<p>No persons detected on that page.</p>'; return; }

    // Build the row skeleton now so the table is visible while stats load.
    const rows = people.map((p) => ({
      person: p,
      crisId: mapping[p.slug] || null,
      profile: null,
      stats: null,
    }));

    const state = { sortKey: 'total', dir: -1 };
    state.onIdEntered = (row) => {
      refreshRow(row, proxyTpl).then(() => renderTable(mount, rows, state));
    };
    renderTable(mount, rows, state);

    // Phase 1: fetch stats for rows that already have an ID from the mapping.
    // Phase 2: auto-discover IDs for the remaining rows via CRIS /search,
    // then fetch their stats.
    const autoDiscover = opts.autoDiscover !== false;  // default true
    const CONCURRENCY  = 4;

    async function workQueue(items, handler) {
      const q = items.slice();
      async function worker() {
        while (q.length) {
          const r = q.shift();
          await handler(r);
          renderTable(mount, rows, state);
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }

    await workQueue(rows.filter((r) => r.crisId), (r) => refreshRow(r, proxyTpl));

    if (autoDiscover) {
      const unknown = rows.filter((r) => !r.crisId);
      await workQueue(unknown, async (r) => {
        r.discovering = true; renderTable(mount, rows, state);
        try {
          const d = await discoverCrisId(r.person, proxyTpl);
          r.discovering = false;
          if (d.id) {
            r.crisId = d.id;
            r.confidence = d.confidence;
            await refreshRow(r, proxyTpl);
          } else {
            r.warn = r.warn || 'no CRIS match';
          }
        } catch (e) {
          r.discovering = false;
          r.warn = 'search error: ' + (e.message || e);
        }
      });
    }
  }

  async function refreshRow(row, proxyTpl) {
    try {
      const res = await loadPerson(row.person, row.crisId, proxyTpl);
      row.profile = res.profile;
      row.stats   = res.stats;
      row.profileUrl = res.profileUrl;
      // Verify personal-website link matches the FAU page.
      if (row.profile.personalWebsite) {
        try {
          const pw = new URL(row.profile.personalWebsite);
          const fu = new URL(row.person.url);
          if (pw.host !== fu.host) {
            row.warn = 'CRIS personal-website link → ' + pw.host;
          }
        } catch (_) { /* ignore */ }
      }
      row.error = null;
    } catch (e) {
      row.error = e.message || String(e);
    }
  }

  return {
    // Low-level exports (handy for testing / extension)
    fetchText, parseTeamPage, parseProfilePage, parseBibtex,
    computeStats, nameMatches, loadPerson, renderTable,
    searchCrisIds, discoverCrisId,
    // High-level driver
    run,
    DEFAULT_PROXIES,
  };
});
