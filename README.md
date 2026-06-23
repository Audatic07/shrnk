# Shrnk

> Working codename — final name lands in M0 (C013).

A fully in-browser media compressor. **Files never leave the device.** Video,
image, and PDF compression run client-side via ffmpeg.wasm and native codecs;
the only thing that touches the network is privacy-safe aggregate analytics
(MB processed, ratio, ms) — never file content, names, or thumbnails.

The engineering centerpiece is a **target-size bitrate-search engine** that
hits a byte budget at maximum quality.

See [ROADMAP.md](ROADMAP.md) for the full build plan.

## Workspace layout

```
apps/      # Astro site (content + the compressor island)
packages/  # engine-core, engine-video, engine-image, engine-pdf,
           # worker-protocol, metrics
```

## Requirements

- Node >= 22
- pnpm 10+

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## License

[MIT](LICENSE)
