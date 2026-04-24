# cris-team-stats

A pure-JavaScript plugin that takes a **FAU team/person listing page** (e.g. the
[Pattern Recognition Lab team](https://lme.tf.fau.de/person/)) and builds a
sortable table of each person's research output, pulled live from **FAU CRIS**
([cris.fau.de](https://cris.fau.de)).

Columns (all sortable):

| # | Column                 | Source                                                                 |
|---|------------------------|-------------------------------------------------------------------------|
| 1 | Name                   | FAU person page                                                         |
| 2 | CRIS profile           | `cris.fau.de/persons/{ID}/`                                             |
| 3 | Journal papers         | count of `@article` in `cris.fau.de/bibtex/person/{ID}.bib`             |
| 4 | Conference papers      | count of `@inproceedings`                                               |
| 5 | First-author papers    | entries whose first author matches the person                           |
| 6 | Projects               | `Project Leads` + `Project Memberships` counts on the profile page      |
| 7 | Years at FAU (approx.) | `currentYear − earliestPublicationYear + 1`                             |
| 8 | Publications / year    | total publications ÷ years at FAU                                       |

## Two versions

1. **Standalone HTML page** ([`index.html`](index.html)) — paste a FAU team-listing
   URL (defaults to `https://lme.tf.fau.de/person/`), click **Build table**,
   and the table renders inline. Also has a **Generate WordPress snippet**
   button.
2. **WordPress-embeddable HTML snippet** ([`wordpress-snippet.html`](wordpress-snippet.html)) — a small block of
   HTML you can paste into a WordPress Custom-HTML block. It pulls the heavy
   lifting (the parser/table renderer) from a CDN (jsDelivr over this GitHub
   repo), so the snippet itself stays short and copy-pasteable.

## How does the matching work?

The FAU person page yields names and person-page slugs (e.g.
`lme.tf.fau.de/persons/andreas-maier/`). CRIS doesn't expose a public
name-search endpoint, so we match via either:

- **An optional mapping file** (`mapping.json`) listing
  `FAU slug → CRIS person ID`. Example: [`examples/lme-mapping.json`](examples/lme-mapping.json).
- A manual **CRIS-ID column** in the UI — next to every row you'll see a tiny
  input where you can type/paste the ID (from the CRIS person URL).

The CRIS profile page reverse-links to the FAU personal website, so once a
mapping row exists the result is verified.

## CORS

Both FAU and CRIS serve pages without `Access-Control-Allow-Origin`, so the
browser cannot fetch them directly from a third-party origin. The plugin proxies
requests through [api.allorigins.win](https://api.allorigins.win) by default.
You can override the proxy in the UI (e.g. to `https://corsproxy.io/?url=` or
your own self-hosted proxy).

## Layout of this repo

```
index.html               # standalone HTML app (copy-paste friendly)
wordpress-snippet.html   # copy-paste WordPress Custom-HTML block
cris-team-stats.js       # core library (fetch + parse + render)
mapping.json             # empty; you can fill this in for your team
examples/
  lme-mapping.json       # sample mapping for the LME team
PLAN.md                  # design / architecture plan (syncs with repo)
README.md                # this file
```

## Quick start

1. Open `index.html` in a browser (no build step).
2. Leave the team-page URL as `https://lme.tf.fau.de/person/` or paste any
   other FAU team-listing page.
3. (Optional) paste a mapping JSON, or fill in CRIS IDs inline.
4. Click **Build table**.
5. Click column headers to sort.
6. Click **Generate WordPress snippet** to get a short HTML block; paste it
   into a WordPress Custom-HTML block on your site.

## Limitations

- Statistics depend entirely on what CRIS has indexed.
- Journal / conference counts use the BibTeX entry type
  (`@article` vs `@inproceedings`). Unusual entry types (e.g. book chapters)
  are not counted as either.
- "Years at FAU" is a proxy: `currentYear − firstPublicationYear + 1`. For
  newcomers with no publications yet, this will be 0.
- The plugin is rate-limited by whatever CORS proxy you use.

## License

MIT.
