# TC News (tc-news)

A news app that automatically collects RSS feeds, generates news articles with an LLM, and shares them with everyone over mistlib P2P rooms. Part of the tik-choco family (tc-chat / tc-note / tc-town, …).

https://tik-choco.github.io/tc-news/

## Features

- **RSS collection** — Register RSS 2.0 / Atom feeds and collect them automatically on an interval. Feeds that block cross-origin requests are fetched through a configurable CORS proxy.
- **Automatic article generation** — Compose news articles (Markdown) from collected items with any OpenAI-compatible LLM, with streaming preview and an optional auto-generate mode.
- **P2P sharing** — Broadcast articles to a mistlib room with DID-signed wires. Everyone in the room receives them, with history replay for late joiners.
- **tc-chat integration** — Send generated articles to tc-chat through the same-origin shared bus (`note-article` topic).

## Development

```sh
cp .env.example .env   # set MISTLIB_REPO
npm install
npm run dev
```

The `predev` / `prebuild` hooks run `scripts/fetch-mistlib.mjs`, which builds mistlib to WASM and vendors it into `src/vendor/mistlib/` (requires Rust + wasm-pack). The built output is committed, so no rebuild is needed unless you update mistlib.

LLM providers are configured in the settings screen (base URL / API key / model). API keys are stored only in the browser's localStorage and never enter the repository.

## Deployment

Pushing to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`), which deploys to GitHub Pages with `VITE_BASE_PATH=/tc-news/`.

## Architecture

Preact + Vite + TypeScript with plain CSS, following the tik-choco family conventions. Articles are distributed over mistlib P2P rooms with DID-signed wires; same-browser hand-off to sibling apps uses the shared bus (BroadcastChannel).
