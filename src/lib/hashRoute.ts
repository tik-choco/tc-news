// URL hash routing: deep links into a tab, an article within a tab, or a
// one-shot room switch on startup. Kept as a small set of pure/DOM-adjacent
// functions (no framework state) so app.tsx can wire it into useState /
// useEffect however it likes.
//
// Recognized shapes:
//   #/feed
//   #/feed/<id>
//   #/shared/<id>
//   #/program
//   #/settings
//   #room=<roomId>
//   #/articles, #/articles/<id> — legacy alias for #/feed(/<id>); "articles"
//   tab was folded into "feed" during the 4-tab IA rework, but links shared
//   before that change must keep resolving.
import type { MainTab } from "../types";

export interface HashState {
  tab: MainTab | null;
  articleId: string | null; // set only for "#/feed/<id>" / "#/shared/<id>"
  room: string | null; // set only for "#room=<roomId>" (startup one-shot)
}

const EMPTY_STATE: HashState = { tab: null, articleId: null, room: null };

function decodeSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isMainTab(value: string): value is MainTab {
  return (
    value === "feed" ||
    value === "shared" ||
    value === "program" ||
    value === "settings"
  );
}

/** Parses a location.hash-shaped string ("#..." or ""). Pure function. */
export function parseHash(hash: string): HashState {
  if (!hash || hash === "#") return EMPTY_STATE;
  const body = hash.startsWith("#") ? hash.slice(1) : hash;

  if (body.startsWith("room=")) {
    const room = decodeSafe(body.slice("room=".length));
    return room ? { tab: null, articleId: null, room } : EMPTY_STATE;
  }

  if (!body.startsWith("/")) return EMPTY_STATE;
  const parts = body.slice(1).split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return EMPTY_STATE;

  const [tabPart, idPart] = parts;

  // Legacy alias: "articles" was its own tab before the 4-tab IA rework
  // folded its features (view/rate/translate/share/chat/delete own articles)
  // into "feed". Links shared as "#/articles" or "#/articles/<id>" before
  // that change must keep resolving, so route them to "feed" here rather
  // than letting isMainTab() reject them below.
  if (tabPart === "articles") {
    if (idPart === undefined) return { tab: "feed", articleId: null, room: null };
    const legacyArticleId = decodeSafe(idPart);
    return legacyArticleId ? { tab: "feed", articleId: legacyArticleId, room: null } : EMPTY_STATE;
  }

  if (!isMainTab(tabPart)) return EMPTY_STATE;

  if (idPart === undefined) return { tab: tabPart, articleId: null, room: null };
  if (tabPart !== "feed" && tabPart !== "shared") return EMPTY_STATE;
  const articleId = decodeSafe(idPart);
  if (!articleId) return EMPTY_STATE;
  return { tab: tabPart, articleId, room: null };
}

export function readHash(): HashState {
  return parseHash(location.hash);
}

/** Updates the URL hash without pushing a history entry or firing a
 * hashchange loop back into our own listeners (replaceState is silent). */
export function writeHash(tab: MainTab, articleId?: string | null): void {
  const path = articleId ? `/${tab}/${encodeURIComponent(articleId)}` : `/${tab}`;
  const url = `${location.pathname}${location.search}#${path}`;
  history.replaceState(null, "", url);
}

/** Subscribes to hashchange (e.g. back/forward navigation). Returns an
 * unsubscribe function. */
export function onHashChange(cb: (state: HashState) => void): () => void {
  function handler() {
    cb(readHash());
  }
  addEventListener("hashchange", handler);
  return () => removeEventListener("hashchange", handler);
}
