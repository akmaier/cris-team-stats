# Architecture / implementation plan

## Data sources

### FAU team-listing page

Example: `https://lme.tf.fau.de/person/`.

Two URL patterns are used for the individual person pages on FAU WordPress
sites:

- `https://{domain}/persons/{slug}/`
- `https://{domain}/our-team/{slug}/`

The listing page contains an `<ul>` with `<li>` entries; each `<li>` has an
`<a href>` pointing at the person page plus the person's name as link text.

**Parser**: given the HTML of the listing page, iterate over every link whose
`href` matches `/(persons|our-team)/[^/]+/` and collect `{ name, slug, url }`.

### CRIS person profile

URL: `https://cris.fau.de/persons/{ID}/`.

- The profile page contains a `<ul tabs>` block with `<li>` entries for each
  sub-section (Publications, Project Leads, Project Memberships, Awards, …).
- Each `<li>` has a `<p class="tab-top">…</p>` giving the section name and a
  `<p class="tab-bottom">(N)</p>` giving the count (`N` may be comma-formatted).
- A `<div class="person-link">` with `<strong>Personal Website:</strong>`
  contains the link back to the FAU personal page — **useful for verifying
  a mapping**.
- `<a href="https://cris.fau.de/bibtex/person/{ID}.bib">` gives us the BibTeX.

### BibTeX

URL: `https://cris.fau.de/bibtex/person/{ID}.bib` — contains **all**
publications as BibTeX entries.

- Entry-type heuristics:
  - `@article` → journal
  - `@inproceedings` or `@conference` → conference
  - other → "other"
- `author = {Last1, First1 and Last2, First2 and …}` — split on ` and ` to
  get the author list in order.
- `year = {YYYY}` — numeric year.

### Publications filter (fallback)

`https://cris.fau.de/persons/{ID}/publications?{type}=on` where `type` is a
publication-type toggle. Counter-intuitively, `?journal=on` **excludes**
journal articles. So:

```
journals     = total_publications − filtered_with(journal=on)
conferences  = total_publications − filtered_with(conference=on)
```

The filtered count lives in an `<h3>Filtered Result(s): N</h3>`. This is a
backup in case the BibTeX download fails or is truncated.

## Matching problem

CRIS does not publish a name-search endpoint (the XML web-service is
FAU-network-only). We therefore support three modes:

1. **mapping JSON** (preferred) — `{ "andreas-maier": 101449090, … }`.
2. **inline input** — the UI shows a small `<input>` next to each row where
   the user can paste a CRIS ID. On blur, the row is refreshed.
3. **reverse-verification** — once an ID is supplied, fetch the CRIS profile
   and confirm the "Personal Website" URL matches the FAU person page. If it
   doesn't, flag the row with a warning icon.

## Fetching across origins (CORS)

Neither `lme.tf.fau.de` nor `cris.fau.de` sets `Access-Control-Allow-Origin: *`,
so the browser blocks cross-origin reads. The plugin goes through a public CORS
proxy; the default is `https://api.allorigins.win/get?url=…` (JSON envelope
with a `contents` field). The proxy is user-configurable because public
proxies tend to come and go. We implement a tiny pluggable fetch layer:

```js
async function fetchText(url, proxyTpl) {
  // proxyTpl is e.g. 'https://api.allorigins.win/get?url={URL}' with '{URL}'
  // as the encoded-URL placeholder. If the template contains '/get?url=' we
  // parse the JSON envelope and return its `contents`.
}
```

## Library shape

`cris-team-stats.js` exposes a single global `CrisTeamStats` with:

- `parseTeamPage(html, baseUrl) -> Person[]`
- `parseProfilePage(html) -> ProfileStats`
- `parseBibtex(bibtex) -> { entries: [...], stats: {...} }`
- `computePersonStats(html, bibtex, person) -> Row`
- `renderTable(container, rows, opts)`
- `run({ teamUrl, mapping, mountEl, proxyTpl })` — the end-to-end driver used
  by both `index.html` and the WordPress snippet.

## Rendering

A plain `<table>` with sortable `<th>` headers. No framework. Click a header
to toggle sort direction. Default sort is by total publications desc.

## WordPress snippet

The embeddable snippet loads `cris-team-stats.js` from jsDelivr:

```html
<div id="cris-team-stats" data-team-url="https://lme.tf.fau.de/person/"></div>
<script src="https://cdn.jsdelivr.net/gh/akmaier/cris-team-stats@main/cris-team-stats.js"></script>
<script>CrisTeamStats.run({ mount: '#cris-team-stats' });</script>
```

WordPress strips `<script>` in the classic editor but leaves it in the
**Custom HTML block** and in the block editor. We document both.

## Why jsDelivr and not `raw.githubusercontent.com`?

`raw.githubusercontent.com` returns `Content-Type: text/plain`, so modern
browsers refuse to execute the script. `cdn.jsdelivr.net/gh/…` serves the
same file with `Content-Type: application/javascript` and is globally cached.

## Stretch goals (not in v1)

- First-author papers per year (bar chart)
- Co-authorship network
- Cache CRIS responses in localStorage for a day

## Test plan

Run against `https://lme.tf.fau.de/person/` with the ID for Andreas Maier
(`101449090`) and verify:

- `@article` count in the bibtex matches the journal column
- `@inproceedings` count matches the conference column
- the first-author count is consistent with `author = {Maier, Andreas and …}`
  entries
- the project count equals `Project Leads + Project Memberships` as displayed
  on his CRIS profile
