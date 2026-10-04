# TC News (tc-news)

A news app that automatically collects RSS feeds, generates news articles with an LLM, and shares them with everyone over mistlib P2P rooms. Part of the tik-choco family (tc-chat / tc-note / tc-town, …).

https://tik-choco.github.io/tc-news/

## Features

- **RSS collection** — Register RSS 2.0 / Atom feeds and collect them automatically on an interval. Feeds that block cross-origin requests are fetched through a configurable CORS proxy.
- **Personal recommendations** — The home RSS and global-news lists automatically learn from clicks and foreground reading on this device. Optional topic feedback is in each article's menu. In Settings → Recommendation settings, switch between For you and Latest, pause/reset learning, or restore hidden articles. Recommendation history stays local; this feature adds no external AI requests.
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

In the tik-choco workspace, run `just dev tc-news` from the parent directory and open `http://localhost:8180/tc-news/`. RSS feeds, article full text, and link previews automatically use the workspace proxy's same-origin `/__cors/` relay after identifying it via `/__dev__/status`. This avoids browser CORS restrictions without relying on a public proxy during development. Standalone Vite and production builds retain direct fetches with the configured CORS proxy as a fallback. That external service must be available and correctly configured; for example, a `401` response from `corsproxy.io` requires a valid API key. Reload the page after changing the development setup to clear cached fetch failures.

## Deployment

Pushing to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`), which deploys to GitHub Pages with `VITE_BASE_PATH=/tc-news/`.

## Architecture

Preact + Vite + TypeScript with plain CSS, following the tik-choco family conventions. Articles are distributed over mistlib P2P rooms with DID-signed wires; same-browser hand-off to sibling apps uses the shared bus (BroadcastChannel).

Recommendations currently use text, tags, and categories with short/long-term interest decay, fresh-topic exploration, and source diversity. They rank already collected RSS and received global articles; they do not discover new sites. Reading waits, background tabs, and failed full-text loads do not count as full-article engagement. Recommendations update automatically after closing the reader or returning to Home; reading and multi-selection keep the list stable. Impression-only updates do not reorder cards. This is the first content-based implementation; semantic embeddings are a later stage.

The private recommendation store uses synchronous localStorage so pause settings are available before the asynchronous mist KV starts. It is bounded to 500 article records and 300 KB, and removes records older than 30 days when accessed. A separate small preference record preserves pause settings if saving the larger history fails. Reading tokens are invalidated by resets and external storage changes. Impressions are aggregated per article with session deduplication; a position-level analytics log is not collected.

Recommendation reasons are hidden during normal use. Enable Developer mode at the bottom of Settings to show them. This preference is specific to tc-news and does not switch dependencies. The settings footer also shows the runtime mistlib version, or `—` when unavailable. The shared diagnostic banner appears for development environments, local engines, or dirty builds, independently of Developer mode.
