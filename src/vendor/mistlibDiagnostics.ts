// Canonical source: protocol/docs/data-contracts/reference/mistlibDiagnostics.ts
// Sync this file; do not edit app copies. No framework, bundler or engine imports.
export type BuildInfo = Readonly<{ version: string; commit: string; dirty: boolean; profile: string; target: string }>;
export type BuildSnapshot = Readonly<{
  source: 'local' | 'registry' | 'unknown';
  state: 'waiting' | 'reported' | 'unverified' | 'load-error';
  info: BuildInfo | null;
}>;
export function parseBuildInfo(raw: unknown): BuildInfo | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object') return null;
    const fields = ['version', 'commit', 'profile', 'target'] as const;
    if (fields.some(key => typeof value[key] !== 'string' || !/^[a-zA-Z0-9.+_-]{1,128}$/.test(value[key]))) return null;
    if (typeof value.dirty !== 'boolean') return null;
    return Object.freeze({ version: value.version, commit: value.commit, dirty: value.dirty, profile: value.profile, target: value.target });
  } catch { return null; }
}
export function createMistlibDiagnostics(options: {
  app: string; source: BuildSnapshot['source']; development: boolean; environment: string;
}) {
  let snapshot: BuildSnapshot = Object.freeze({ source: options.source, state: 'waiting', info: null });
  const listeners = new Set<() => void>();
  function publish(state: BuildSnapshot['state'], info: BuildInfo | null = null) {
    snapshot = Object.freeze({ source: options.source, state, info });
    listeners.forEach(listener => listener());
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // Call after the app initialized its engine. This never initializes WASM or a node.
    capture(engine: unknown) {
      try {
        const api = engine as Record<string, unknown>;
        const getInfo = api?.['get_build_info'];
        const info = typeof getInfo === 'function' ? parseBuildInfo(getInfo()) : null;
        publish(info ? 'reported' : 'unverified', info);
      } catch { publish('unverified'); }
    },
    markLoadError: () => publish('load-error'),
    isDevelopment: () => options.development || snapshot.source === 'local' || snapshot.info?.dirty === true,
    diagnostic: () => JSON.stringify({
      app: options.app, environment: options.environment, ...snapshot,
      artifactVerification: 'not-implemented', wrapperRevision: 'unknown',
    }, null, 2),
  };
}
export type MistlibDiagnostics = ReturnType<typeof createMistlibDiagnostics>;

const css = `
:host { display:block; font:12px/1.5 system-ui,sans-serif; }
details { max-height:45dvh; overflow:auto; background:#fff3cd; color:#4b3500; border-bottom:1px solid #c49729; }
summary { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; padding:6px 12px; cursor:pointer; }
summary:focus-visible { outline:2px solid #4b3500; outline-offset:-3px; }
strong { letter-spacing:.05em; } .more { margin-left:auto; text-decoration:underline; }
.body { padding:0 12px 12px; } p { margin:8px 0; }
button { background:#fff; color:#4b3500; border:1px solid #9b7418; border-radius:4px; padding:5px 10px; margin-right:8px; cursor:pointer; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
.version { font:inherit; color:inherit; } a { color:inherit; text-underline-offset:2px; }
`;
/** Owns a child of host, not the host itself. Dispose on unmount. Safe to remount. */
export function mountMistlibDiagnostics(host: HTMLElement, store: MistlibDiagnostics, view: 'banner' | 'settings' = 'banner') {
  const container = document.createElement('div');
  const root = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  host.append(container);
  let disposed = false;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  let update: () => void;
  if (view === 'settings') {
    const line = el('span'); line.className = 'version';
    const link = el('a', 'mistlib');
    link.href = 'https://github.com/tik-choco-lab/mistlib';
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    const version = el('span');
    line.append(link, document.createTextNode(' '), version);
    root.append(line);
    update = () => { version.textContent = store.getSnapshot().info?.version ?? '—'; };
  } else {
    const details = el('details');
    const summary = el('summary');
    const title = el('strong'); const version = el('span'); const commit = el('code'); const status = el('span');
    const more = el('span', '詳細'); more.className = 'more';
    summary.append(title, version, commit, status, more);
    const body = el('div'); body.className = 'body';
    const note = el('p', '実行中の mistlib の情報です。成果物の整合性は未検証です。');
    const message = el('p');
    const button = el('button', '診断情報をコピー'); button.type = 'button';
    const result = el('span'); result.setAttribute('role', 'status');
    const pre = el('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'mistlib 診断情報');
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(store.diagnostic());
        if (!disposed) result.textContent = 'コピーしました';
      } catch {
        if (!disposed) result.textContent = 'コピーできませんでした。下の情報を選択してコピーしてください。';
      }
    };
    body.append(note, message, button, result, pre);
    details.append(summary, body); root.append(details);
    update = () => {
      const build = store.getSnapshot();
      // Hide the host child as well: no production banner or reserved space.
      container.hidden = !store.isDevelopment();
      container.style.display = container.hidden ? 'none' : '';
      title.textContent = store.isDevelopment() ? 'DEVELOPMENT' : 'MISTLIB';
      version.textContent = `mistlib ${build.info?.version ?? 'version 不明'} · ${build.source}`;
      commit.textContent = build.info ? build.info.commit.slice(0, 8) + (build.info.dirty ? '+dirty' : '') : '';
      commit.hidden = !build.info;
      status.textContent = { waiting: '初期化待ち', reported: '実行情報取得済み・整合性は未検証', unverified: 'VERSION UNVERIFIED', 'load-error': 'MISTLIB LOAD ERROR' }[build.state];
      message.textContent = build.state === 'waiting' ? 'アプリが mistlib を初期化すると更新されます。' : build.state === 'unverified' ? 'この版では情報 API が使えないか、返された情報を確認できませんでした。' : '';
      message.hidden = !message.textContent;
      pre.textContent = store.diagnostic(); result.textContent = '';
    };
  }
  const unsubscribe = store.subscribe(update);
  update();
  return () => { disposed = true; unsubscribe(); container.remove(); };
}
