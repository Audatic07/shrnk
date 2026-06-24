# Client-Side Media Compressor — Long-Term Build Plan

> Working codename: **Shrnk** (rename in M0). A fully in-browser media compressor.
> Files never leave the device. Distribution is SEO. Hosting cost is ~$0.
> The engineering centerpiece is a **target-size bitrate-search engine** that hits
> a byte budget at maximum quality.

---

## 0. Thesis & non-negotiables

**Product thesis.** People constantly hit hard file-size walls (WhatsApp 16MB video,
Discord 10/25MB, Gmail 25MB, gov portals "PDF under 100KB"). Existing tools upload your
file — slow, privacy-leaking, size-capped. We do everything in-browser with ffmpeg.wasm +
native codecs, so the file never leaves the machine. The traffic comes from high-intent,
recurring searches; rank for a handful and it compounds for free. Static hosting means a
single box never falls over — the #1 reason indie tools die at scale is removed.

**Non-negotiable invariants (enforced for the life of the project):**

1. **No file bytes ever touch the network.** Analytics may send *aggregate numbers*
   (MB processed, ratio, ms) but never file content, names, or thumbnails. This is the
   brand. One violation kills the value prop.
2. **Static-deployable.** No origin server in the hot path. Anything dynamic must be
   build-time or edge-cached static.
3. **Graceful degradation.** Multi-threaded (SharedArrayBuffer) path when available,
   single-threaded fallback always works. Old/locked-down browsers still get *a* result.
4. **The tab must not crash.** Large files stream; memory is budgeted; OOM is caught and
   reported, never a white screen.
5. **Every programmatic page is a real, working tool** — never a thin doorway page.

**Resume-worthy depth (the parts that are actually hard):**

- The bitrate-search loop that converges on a size budget at max quality.
- Web Workers + SharedArrayBuffer + cross-origin isolation on a *static* host.
- Streaming multi-hundred-MB files through wasm without OOM (WORKERFS mounting).
- A programmatic-SEO engine that scales pages without tripping thin-content penalties.

---

## 1. Tech-stack decisions (opinionated, with rationale)

| Concern            | Choice                                                                                                                                  | Why                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site framework     | **Astro**                                                                                                                         | Ships static HTML per route (great LCP/SEO), hydrates the compressor as an island only on tool pages. Heavy wasm never loads on content pages.                         |
| Compressor UI      | **Preact or Svelte island**                                                                                                       | Tiny runtime; the app is one interactive island, not a SPA.                                                                                                            |
| Video/audio engine | **ffmpeg.wasm** (`@ffmpeg/ffmpeg` 0.12+), both `@ffmpeg/core` (ST) and `@ffmpeg/core-mt` (MT)                               | MT needs SharedArrayBuffer; ST is the universal fallback.                                                                                                              |
| Image engine       | **Canvas/`createImageBitmap` first**, then `mozjpeg`/`oxipng`/`libwebp` wasm for better ratios; `libheif` wasm for HEIC | Canvas is zero-dependency and covers 80%; wasm codecs win the quality/ratio benchmarks.                                                                                |
| PDF engine         | **mupdf-wasm** or **Ghostscript-wasm** (image downsample + re-encode + font subset)                                         | ffmpeg can't touch PDF. This is a separate engine — budget for it.                                                                                                    |
| Hosting            | **Cloudflare Pages** (primary)                                                                                                    | Free, global edge, supports custom`_headers` for COOP/COEP, generous bandwidth. GitHub Pages can't set headers → needs the service-worker COI hack (fallback only). |
| Analytics          | **Cloudflare Web Analytics or self-hosted Umami** + custom client events                                                          | Cookieless, privacy-respecting — consistent with the brand.                                                                                                           |
| Search data        | **Google Search Console + Bing Webmaster**                                                                                        | Source of truth for rankings/impressions/CTR.                                                                                                                          |
| Lang/tooling       | **TypeScript, Vite (via Astro), pnpm, Vitest, Playwright**                                                                        | Type safety around the worker protocol; Playwright drives real-file E2E.                                                                                               |
| CI/CD              | **GitHub Actions** → build → Lighthouse CI gate → deploy to CF Pages                                                           | Performance budget enforced on every PR.                                                                                                                               |

**Cross-origin isolation (the gotcha that bites everyone).** `SharedArrayBuffer` →
multi-threaded ffmpeg requires the document to be *cross-origin isolated*, which requires
two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

On Cloudflare Pages/Netlify/Vercel you set these via `_headers`/config. On GitHub Pages
you **cannot** set headers — the workaround is the `coi-serviceworker` shim that injects
them client-side. COEP `require-corp` also means every cross-origin subresource (fonts,
analytics) must send `Cross-Origin-Resource-Policy` or be loaded `crossorigin` — plan the
asset pipeline around this from day one.

---

## 2. The bitrate-search engine (the crown jewel)

Goal: given a **target byte budget** `B` and a source, produce the **highest-quality**
output that fits under `B`. Naïve `bitrate = B*8/duration` overshoots/undershoots wildly
(container overhead, VBR variance, keyframe spikes). Real approach:

1. **Probe.** Read duration, resolution, fps, audio layout via `ffprobe`-style parse of
   ffmpeg log output.
2. **Budget split.** Reserve audio (with a quality floor, e.g. 96–128kbps, or drop to mono
   /lower for tiny budgets), reserve container overhead (~2–5%), rest is video.
3. **Resolution/fps guard.** Below a bitrate-per-pixel threshold, *downscale* (and/or cap
   fps) — spending bits on 1080p at 200kbps looks worse than clean 480p. Pick the rung
   (1080/720/540/480/360) that maximizes quality at the target bitrate.
4. **Search.** Treat encoded-size as a function of the control knob and converge:
   - **2-pass ABR**: set average bitrate, run pass 1 (analysis) + pass 2. Most predictable
     size; ~2× time.
   - **CRF probing**: encode at a CRF, measure size, **secant/binary-search CRF→size**
     (size is monotonic in CRF). Fewer wasted passes, great quality.
   - Hybrid: CRF probe a *short representative slice* to seed the bitrate, then one 2-pass
     full encode. Big speedup on long videos.
5. **Converge to within tolerance** (e.g. 95–99% of `B`, never over). Cap iterations
   (3–5) so worst case is bounded. Cache the size↔knob samples to inform the next step.
6. **Codec ladder.** H.264 (max compatibility, default) → offer H.265/VP9/AV1 for better
   ratio where the target platform supports it. AV1 in wasm is slow — gate behind an
   "extra small, slower" toggle.

The same convergence pattern generalizes:

- **Images**: binary-search JPEG/WebP quality on output size.
- **PDF**: search image-downsample DPI + JPEG quality of embedded images on output size.

This module is pure, deterministic, and **unit-tested against fixtures** — it's the part of
the repo that reads as senior engineering, so it gets its own package with its own tests.

---

## 3. Architecture map

```
apps/web (Astro)
  ├─ content/            # MDX guides, FAQs, comparisons
  ├─ data/keywords.ts    # source of truth for programmatic pages
  ├─ pages/
  │   ├─ index.astro
  │   ├─ [tool]/[slug].astro      # programmatic landing pages
  │   └─ guides/*.mdx
  └─ islands/Compressor.tsx        # the only heavy hydrated island
packages/
  ├─ engine-core/        # codec-agnostic: queue, target-size search, budget math
  ├─ engine-video/       # ffmpeg.wasm driver (MT/ST detect, WORKERFS, 2-pass)
  ├─ engine-image/       # canvas + mozjpeg/oxipng/libwebp/libheif
  ├─ engine-pdf/         # mupdf/ghostscript wasm
  ├─ worker-protocol/    # typed messages between UI and workers
  └─ metrics/            # client counters + privacy-safe event sink
```

---

## 4. Sequencing strategy (avoid the classic failure mode)

**Do not build 500 SEO pages before one ranks.** The arc is deliberately:
ship **one excellent tool on one real keyword** (M5), get it indexed and measure
real CTR/position (M6), *then* scale formats and programmatic pages (M7–M11). SEO is a
feedback loop, not a big-bang. Each later milestone is justified by data from Search Console.

---

## 5. Milestone map

| Milestone | Theme                                               | Commits    | Ships at end                                    |
| --------- | --------------------------------------------------- | ---------- | ----------------------------------------------- |
| M0        | Foundation, tooling, hosting, COOP/COEP             | C001–C015 | Empty deployed site, CI green, headers verified |
| M1        | ffmpeg.wasm spike (ST)                              | C016–C029 | Transcode a file in-browser (ugly but real)     |
| M2        | Worker architecture + progress + MT detect          | C030–C043 | Non-blocking UI, MT path, cancel                |
| M3        | **Target-size bitrate-search engine (video)** | C044–C065 | Hit a byte budget at max quality                |
| M4        | Large-file handling (streaming/WORKERFS/OOM)        | C066–C079 | 500MB+ files without crashing                   |
| M5        | First shippable tool + first landing page           | C080–C097 | "Compress video for WhatsApp" live              |
| M6        | SEO foundation + indexing                           | C098–C113 | Sitemap, schema, indexed, GSC wired             |
| M7        | Image compressor                                    | C114–C129 | Image tools + ratio benchmarks                  |
| M8        | PDF compressor                                      | C130–C147 | "Reduce PDF size / under 100KB"                 |
| M9        | Format-conversion matrix                            | C148–C163 | mov→mp4, mkv→mp4, webm→mp4, …               |
| M10       | Programmatic SEO scale                              | C164–C181 | Hundreds of real tool pages from data           |
| M11       | Audio + GIF                                         | C182–C195 | mp3/aac compress, video→gif, gif compress      |
| M12       | Performance, PWA, polish                            | C196–C211 | Offline, fast LCP, a11y, i18n scaffold          |
| M13       | Analytics, benchmarks, metrics                      | C212–C225 | MB processed, ratio, vs-server dashboard        |
| M14       | Growth, content, hardening, launch                  | C226–C241 | Public launch, content engine, monitoring       |

**Total: 241 planned commits** (buffer above the 200 target for the fixes/reverts every
real project incurs). Conventional Commits throughout (`feat:`/`fix:`/`perf:`/`docs:`/
`test:`/`chore:`/`refactor:`).

---

## 6. Enumerated commit log

### M0 — Foundation (C001–C015)

- C001 `chore: init repo, pnpm workspace, MIT license, .gitignore, .editorconfig`
- C002 `chore: add TypeScript base config + strict settings shared across packages`
- C003 `chore: scaffold Astro app with base layout and 404`
- C004 `chore: set up ESLint + Prettier + lint-staged + Husky pre-commit`
- C005 `chore: Vitest config + first trivial passing test`
- C006 `chore: Playwright config + smoke test (home renders)`
- C007 `ci: GitHub Actions build + test on PR`
- C008 `chore: Cloudflare Pages deploy config (wrangler/pages)`
- C009 `feat: _headers with COOP same-origin + COEP require-corp`
- C010 `feat: runtime crossOriginIsolated probe + on-page diagnostic banner`
- C011 `feat: coi-serviceworker fallback for hosts without header control`
- C012 `docs: ARCHITECTURE.md + this ROADMAP + CONTRIBUTING`
- C013 `feat: brand pass — rename to final name, logo, favicon, color tokens`
- C014 `ci: Lighthouse CI with performance budget gate`
- C015 `chore: error boundary + privacy-safe client logger (no PII)`

### M1 — ffmpeg.wasm spike, single-threaded (C016–C029)

- C016 `chore: add @ffmpeg/ffmpeg + @ffmpeg/core (ST), self-host core assets`
- C017 `feat: lazy-load ffmpeg core only on tool route`
- C018 `feat: minimal file <input> + drag-drop dropzone`
- C019 `feat: load() ffmpeg with progress + log event wiring`
- C020 `feat: writeFile → exec basic H.264 transcode → readFile → download`
- C021 `feat: object-URL download with correct mime + filename`
- C022 `feat: parse ffmpeg log for duration/resolution/fps/audio (probe)`
- C023 `feat: surface probe metadata in UI`
- C024 `fix: revoke object URLs + free MEMFS to stop leaks between runs`
- C025 `feat: friendly error mapping for common ffmpeg failures`
- C026 `test: probe parser unit tests against captured log fixtures`
- C027 `perf: cache loaded core across runs in a session`
- C028 `feat: feature-detect WASM + SAB and report capability tier`
- C029 `docs: engine-video README + supported-input notes`

### M2 — Worker architecture + progress + MT (C030–C043)

- C030 `refactor: extract engine-video package`
- C031 `feat: worker-protocol package — typed request/response/event messages`
- C032 `feat: run ffmpeg inside a dedicated Web Worker`
- C033 `feat: structured progress events (probe→encode→finalize phases)`
- C034 `feat: determinate progress bar + ETA from progress stream`
- C035 `feat: cancel/abort mid-encode + clean teardown`
- C036 `chore: add @ffmpeg/core-mt assets, self-hosted`
- C037 `feat: choose MT core when crossOriginIsolated else ST`
- C038 `feat: thread-count heuristic from hardwareConcurrency`
- C039 `fix: COEP-safe loading of worker + wasm (crossorigin/CORP)`
- C040 `test: worker-protocol message contract tests`
- C041 `feat: job queue for multiple files (sequential, memory-aware)`
- C042 `perf: keep worker warm; reuse across queued jobs`
- C043 `fix: terminate + respawn worker on fatal wasm error (self-heal)`

### M3 — Target-size bitrate-search engine, video (C044–C065)

- C044 `feat: engine-core package — budget math (size↔bitrate↔duration)`
- C045 `feat: audio budget allocation with quality floor + mono fallback`
- C046 `feat: container-overhead reserve model`
- C047 `feat: resolution ladder selector by bitrate-per-pixel threshold`
- C048 `feat: fps cap heuristic for very low budgets`
- C049 `feat: single-pass ABR encode path`
- C050 `feat: 2-pass ABR encode (passlog in MEMFS)`
- C051 `feat: CRF encode path`
- C052 `feat: CRF→size probe + secant/binary search to target`
- C053 `feat: representative-slice probing to seed full encode`
- C054 `feat: convergence loop with tolerance + max-iteration cap`
- C055 `feat: never-overshoot guarantee + final verify pass`
- C056 `feat: target presets (WhatsApp 16MB, Discord 10/25, Gmail 25, custom)`
- C057 `feat: quality-vs-size strategy selector (fast / balanced / smallest)`
- C058 `feat: H.265 + VP9 codec options behind capability gates`
- C059 `feat: experimental AV1 path (slow toggle, warning)`
- C060 `test: budget math unit tests`
- C061 `test: convergence tests against fixture clips (size within tolerance)`
- C062 `test: resolution-ladder selection tests`
- C063 `perf: reuse pass-1 analysis across iterations where valid`
- C064 `feat: per-job result report (in/out size, ratio, knob, iterations, ms)`
- C065 `docs: engine design doc — the bitrate-search algorithm`

### M4 — Large-file handling (C066–C079)

- C066 `feat: stream File reads in chunks into MEMFS with progress`
- C067 `feat: WORKERFS mount of File/Blob (avoid full in-memory copy)`
- C068 `feat: memory budget estimator from file size + device memory`
- C069 `feat: pre-flight warning + degraded path for oversized inputs`
- C070 `fix: catch wasm OOM (abort) → actionable message, no white screen`
- C071 `feat: auto-suggest ST/lower-res when MT OOMs`
- C072 `perf: avoid duplicate buffers; transfer not copy across worker boundary`
- C073 `feat: streamed output read for large results`
- C074 `feat: chunked download via File System Access API where supported`
- C075 `test: synthetic large-file harness (generated, not committed)`
- C076 `feat: per-device memory cap config + telemetry of OOM rate`
- C077 `fix: release WORKERFS mounts + buffers after each job`
- C078 `perf: backpressure on queue when memory pressure detected`
- C079 `docs: large-file handling notes + known device limits`

### M5 — First shippable tool + first landing page (C080–C097)

- C080 `feat: Compressor island — polished single-tool UX`
- C081 `feat: target picker (preset chips + custom MB/KB) wired to engine`
- C082 `feat: before/after size + ratio + time result card`
- C083 `feat: in-browser preview (HTML5 video) of output`
- C084 `feat: re-run at different target without re-upload`
- C085 `feat: drag-drop + paste + click-to-pick, mobile file picker`
- C086 `feat: full a11y pass on the tool (keyboard, ARIA, focus)`
- C087 `feat: empty/error/loading/success states`
- C088 `feat: landing page /compress-video-for-whatsapp with the tool embedded`
- C089 `feat: unique copy, how-it-works, privacy callout above the fold`
- C090 `feat: FAQ section with answers specific to WhatsApp limits`
- C091 `feat: SoftwareApplication + FAQPage JSON-LD on the page`
- C092 `feat: OpenGraph/Twitter cards + share image`
- C093 `perf: defer engine load until user interacts (protect LCP)`
- C094 `test: Playwright E2E — upload sample, hit 16MB, assert under target`
- C095 `feat: privacy-safe success event (MB in/out, ratio, ms)`
- C096 `fix: cross-browser pass (Chrome/Firefox/Safari/mobile Safari)`
- C097 `chore: ship to production + verify headers + verify isolation live`

### M6 — SEO foundation + indexing (C098–C113)

- C098 `feat: sitemap.xml generation`
- C099 `feat: robots.txt + canonical URLs`
- C100 `feat: global meta/title/description system per route`
- C101 `feat: BreadcrumbList + HowTo JSON-LD components`
- C102 `feat: internal-linking component (related tools)`
- C103 `chore: register Google Search Console + Bing Webmaster, submit sitemap`
- C104 `feat: 301 redirect + canonical strategy for slug variants`
- C105 `perf: inline critical CSS, preconnect, font-display swap`
- C106 `perf: hit Core Web Vitals budget (LCP/CLS/INP) on tool pages`
- C107 `feat: guide content type (MDX) + first guide ("send long videos on WhatsApp")`
- C108 `feat: home page positioning + tool directory`
- C109 `feat: 404 with search + suggestions`
- C110 `docs: SEO playbook (keyword clusters, page template rules)`
- C111 `feat: analytics dashboard link + GSC API pull script (build-time)`
- C112 `fix: structured-data validation (Rich Results test) fixes`
- C113 `chore: measure baseline — impressions/position after indexing`

### M7 — Image compressor (C114–C129)

- C114 `feat: engine-image package — Canvas/createImageBitmap pipeline`
- C115 `feat: JPEG quality binary-search to target size`
- C116 `feat: PNG path (canvas) + oxipng-wasm lossless optimize`
- C117 `feat: WebP encode via libwebp-wasm with quality search`
- C118 `feat: mozjpeg-wasm path for superior JPEG ratio`
- C119 `feat: HEIC decode via libheif-wasm → JPEG/WebP`
- C120 `feat: resize/max-dimension controls + EXIF strip (privacy)`
- C121 `feat: batch image queue with per-file results`
- C122 `feat: image tool UI + before/after visual diff`
- C123 `feat: landing pages: compress-image, png-to-jpg, heic-to-jpg, resize-image`
- C124 `feat: per-page schema + FAQ + how-to`
- C125 `test: ratio/quality benchmark fixtures (mozjpeg vs canvas)`
- C126 `test: E2E image compress to target`
- C127 `perf: offload image codecs to worker; OffscreenCanvas where available`
- C128 `feat: PNG→WebP/JPEG conversion options`
- C129 `docs: engine-image README + benchmark numbers`

### M8 — PDF compressor (C130–C147)

- C130 `chore: evaluate mupdf-wasm vs ghostscript-wasm (spike, decide)`
- C131 `feat: engine-pdf package skeleton + worker`
- C132 `feat: parse PDF, enumerate pages + embedded images`
- C133 `feat: downsample embedded images to target DPI`
- C134 `feat: re-encode images (JPEG/JPXR) with quality search`
- C135 `feat: drop/strip metadata, optimize content streams`
- C136 `feat: font subsetting where engine supports it`
- C137 `feat: target-size search loop for PDF (DPI×quality)`
- C138 `feat: never-overshoot + min-legibility floor (don't destroy text scans)`
- C139 `feat: PDF tool UI + page-count/preview + result card`
- C140 `feat: landing pages: reduce-pdf-size, compress-pdf-to-100kb/200kb/500kb/1mb`
- C141 `feat: per-page schema + FAQ (gov-portal use cases)`
- C142 `test: PDF fixtures — scanned, image-heavy, text-heavy`
- C143 `test: assert under target + text still extractable`
- C144 `fix: handle encrypted/locked PDFs gracefully`
- C145 `perf: stream large PDFs page-by-page to bound memory`
- C146 `feat: merge/split utility pages (adjacent high-intent keywords)`
- C147 `docs: engine-pdf README + limitations`

### M9 — Format-conversion matrix (C148–C163)

- C148 `feat: generic transcode pipeline (any→any container/codec)`
- C149 `feat: mov→mp4 (fast remux when codecs compatible, else transcode)`
- C150 `feat: mkv→mp4, webm→mp4, avi→mp4, flv→mp4`
- C151 `feat: mp4→webm, mp4→mov`
- C152 `feat: smart remux detection (stream-copy when possible = instant)`
- C153 `feat: audio extract (video→mp3/aac/wav)`
- C154 `feat: conversion tool UI with format auto-detect`
- C155 `feat: data-driven conversion landing-page template`
- C156 `feat: generate top-volume conversion pages from keyword data`
- C157 `feat: per-conversion FAQ + schema + internal links`
- C158 `test: remux-vs-transcode decision tests`
- C159 `test: E2E for top 5 conversions`
- C160 `feat: codec/container compatibility matrix surfaced in UI`
- C161 `fix: rotation/metadata preservation on remux`
- C162 `perf: stream-copy path benchmark + telemetry`
- C163 `docs: conversion matrix + which are instant`

### M10 — Programmatic SEO scale (C164–C181)

- C164 `feat: keyword dataset schema (operation, format, target, intent, volume)`
- C165 `feat: page generator — one route per valid (op×format×target)`
- C166 `feat: uniqueness guardrails — templated copy must vary meaningfully`
- C167 `feat: per-page tailored FAQ/how-to generation from data`
- C168 `feat: automatic internal-link graph (clusters + hub pages)`
- C169 `feat: hub/category pages per cluster (video, image, pdf, audio)`
- C170 `feat: breadcrumb + related-tools on every generated page`
- C171 `feat: dynamic OG image generation at build time`
- C172 `chore: prune/merge thin combos; only ship pages with real utility`
- C173 `feat: sitemap index split by cluster; lastmod automation`
- C174 `perf: keep generated pages within CWV budget (no regressions at scale)`
- C175 `feat: A/B title/description templates + GSC CTR feedback loop`
- C176 `test: snapshot tests for generated-page structure + schema validity`
- C177 `test: link-graph integrity (no orphans, no dead links)`
- C178 `chore: submit expanded sitemaps; monitor index coverage`
- C179 `feat: "near miss" target pages (e.g. compress-to-8mb, -50mb) from data`
- C180 `docs: programmatic-SEO guardrails (avoid doorway-page penalties)`
- C181 `chore: coverage review — kill underperformers, double down on winners`

### M11 — Audio + GIF (C182–C195)

- C182 `feat: engine audio path — mp3/aac/opus encode with bitrate search`
- C183 `feat: audio target-size loop + sample-rate/channel downmix guards`
- C184 `feat: audio tool UI + waveform-free lightweight preview`
- C185 `feat: landing pages: compress-mp3, reduce-audio-file-size, m4a-to-mp3`
- C186 `feat: video→gif with palette generation (2-pass palettegen/paletteuse)`
- C187 `feat: gif size control (fps/scale/colors search to target)`
- C188 `feat: gif compress/optimize for existing gifs`
- C189 `feat: gif/audio landing pages + schema + FAQ`
- C190 `test: audio target-size convergence tests`
- C191 `test: gif palette quality + size tests`
- C192 `perf: gif palette caching across size attempts`
- C193 `feat: video→webp/apng animated alternatives`
- C194 `fix: long-audio memory handling`
- C195 `docs: audio/gif engine notes`

### M12 — Performance, PWA, polish (C196–C211)

- C196 `feat: service worker — precache shell + on-demand cache core wasm`
- C197 `feat: full offline support (works on a plane after first load)`
- C198 `feat: PWA manifest + installable + file-handler registration`
- C199 `feat: "open with" OS file-association handling (PWA)`
- C200 `perf: code-split engines so each tool loads only its codecs`
- C201 `perf: preload/prefetch core on intent (hover/touchstart)`
- C202 `feat: dark mode + design-system tokens`
- C203 `feat: i18n scaffolding + hreflang (structure only, en first)`
- C204 `feat: keyboard shortcuts + power-user batch mode`
- C205 `a11y: WCAG AA audit + fixes across all tools`
- C206 `perf: shrink JS island bundles; audit third-party weight`
- C207 `feat: settings persistence (last target, codec) in localStorage`
- C208 `fix: Safari-specific wasm/SAB quirks`
- C209 `fix: mobile memory limits + low-end device tuning`
- C210 `test: Lighthouse CI thresholds raised + enforced`
- C211 `docs: performance budget + PWA notes`

### M13 — Analytics, benchmarks, metrics (C212–C225)

- C212 `feat: metrics package — privacy-safe event sink (no file data)`
- C213 `feat: cumulative MB-processed counter (local + aggregate event)`
- C214 `feat: median compression-ratio tracking at fixed quality`
- C215 `feat: processing-time instrumentation per stage`
- C216 `feat: success/failure + OOM-rate telemetry`
- C217 `feat: vs-server benchmark harness (same files, time + ratio)`
- C218 `feat: public "/benchmarks" page — us vs upload-based tools`
- C219 `feat: GSC API pull → internal rankings dashboard (build-time JSON)`
- C220 `feat: MAU estimation via privacy-safe analytics`
- C221 `feat: in-app "X MB compressed by this site" social-proof counter`
- C222 `test: metrics never include filenames/content (guard test)`
- C223 `feat: funnel events (page→pick→compress→download) for CTR analysis`
- C224 `feat: alerting on error-rate / OOM-rate spikes`
- C225 `docs: metrics definitions + dashboard guide`

### M14 — Growth, content, hardening, launch (C226–C241)

- C226 `feat: comparison pages (vs CloudConvert / vs online-compress tools)`
- C227 `feat: long-form guides per cluster (how to email large video, etc.)`
- C228 `feat: glossary (bitrate, codec, CRF, container) for topical authority`
- C229 `feat: changelog + "what's new" page`
- C230 `feat: shareable result links (config only, never file) + embed widget`
- C231 `chore: security headers (CSP compatible with wasm/workers), SRI`
- C232 `chore: dependency audit + wasm supply-chain pinning + Renovate`
- C233 `test: full E2E matrix across tools on CI nightly`
- C234 `chore: load/perf soak on representative devices`
- C235 `feat: optional donation/Pro presets (fund the $0-server promise)`
- C236 `feat: cookieless consent-free analytics confirmation + privacy page`
- C237 `docs: public README, screenshots, architecture writeup (portfolio)`
- C238 `chore: Show HN / Reddit / Product Hunt launch assets`
- C239 `chore: launch — monitor traffic, errors, rankings`
- C240 `fix: post-launch triage batch`
- C241 `chore: retro + next-quarter keyword-expansion backlog`

---

## 7. Definition of done per milestone (acceptance gates)

- **M0**: site deployed, CI green, `crossOriginIsolated === true` verified in prod.
- **M1**: a real file transcodes end-to-end in the browser.
- **M2**: UI never freezes during encode; cancel works; MT used when available.
- **M3**: for a 200MB sample, output lands within tolerance of a 16MB target and looks
  good; convergence ≤5 iterations; unit tests green.
- **M4**: a 500MB+ file processes without crashing; OOM produces a friendly message.
- **M5**: `/compress-video-for-whatsapp` live, passes E2E, Lighthouse ≥95.
- **M6**: indexed in GSC; valid rich results; baseline impressions recorded.
- **M7/M8/M9/M11**: each engine has target-size search + tests + ≥1 ranked-intent page.
- **M10**: hundreds of generated pages, zero orphans/dead links, CWV not regressed.
- **M12**: installable PWA, full offline, bundle budgets met.
- **M13**: MB-processed, median ratio, processing-time, MAU all measured; guard test
  proves no file data leaves the device.
- **M14**: public launch executed; monitoring + content engine in place.

---

## 8. Risk register

| Risk                                       | Likelihood | Mitigation                                                                               |
| ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------- |
| Can't set COOP/COEP on chosen host         | Med        | Cloudflare Pages primary; coi-serviceworker fallback (C011)                              |
| ffmpeg.wasm OOM on big files               | High       | WORKERFS mount, memory budgeting, ST/low-res fallback (M4)                               |
| Safari/iOS SAB + memory quirks             | High       | ST fallback always works; device-specific tuning (C208/C209)                             |
| Thin-content / doorway-page SEO penalty    | Med        | Every page is a working tool + unique content; prune thin combos (C166/C172/C180)        |
| AV1/HEVC encode too slow in wasm           | Med        | Default H.264; advanced codecs are opt-in slow toggles                                   |
| PDF engine can't subset/optimize enough    | Med        | Spike both engines first (C130); legibility floor (C138)                                 |
| Slow SEO ramp (months to rank)             | High       | Ship one tool early, compound; don't gate product on rankings                            |
| ffmpeg.wasm/codec licensing for hosted use | Low/Med    | Confirm LGPL/GPL build implications; document; prefer permissive codecs where it matters |
| Single-maintainer burnout                  | Med        | Static host = no ops load; automate CI/deploy/monitoring                                 |

---

## 9. Metrics — definitions (the ones you'll report)

- **MB processed**: sum of input bytes across all jobs (aggregate event, not file data).
- **Median compression ratio at fixed quality**: input/output at a held CRF or preset, so
  it's comparable over time and across the codec ladder.
- **Processing time vs server-based competitors**: same fixture set, wall-clock, published
  on `/benchmarks` (C217–C218).
- **MAU**: cookieless analytics unique-visitor estimate.
- **Keyword rankings**: average position + impressions + CTR per cluster from GSC (C219).
- **Reliability**: success rate, OOM rate, error rate (C216, C224).

---

## 10. First-week concrete start (the literal first moves)

1. C001–C008: repo, workspaces, Astro, lint/test, CI, CF Pages deploy.
2. C009–C011: get `crossOriginIsolated` true in production — **prove SAB works before
   writing engine code.** This de-risks everything.
3. C016–C020: smallest possible "pick a file → transcode → download" spike.
4. Only then start engine-core (M3). The bitrate-search engine is the moat; everything
   before it is plumbing to make it shippable.
