// Read-only client for the tik-choco family's well-known global article room
// (`tc-global-articles`, see GLOBAL_ARTICLES_ROOM_ID in ./newsWire), plus the
// "forward" helpers that re-broadcast an already-signed wire into it
// unmodified.
//
// IMPORTANT: like src/lib/sharedBus.ts, this file is meant to be vendored
// (copied, modulo TS/JS syntax) into other tik-choco family apps that want
// to read or forward into the global article feed without pulling in
// tc-news's UI. It intentionally depends only on ./mistClient, ./wireSign
// and ./newsWire's types/constants — no hooks, no view code — so it can be
// dropped into another app alongside copies of those three files. See
// protocol/docs/data-contracts/docs/global-articles-wire.md for the wire
// contract this file implements (mirrors SHARED_BUS.md's role for
// sharedBus.ts), and src/hooks/useNewsRoom.ts for the read/write hook this
// file's receive path is a simplified, subscribe-only port of.
//
// tc-news itself does NOT use subscribeGlobalArticles(): app.tsx displays
// the global room via useNewsRoom(GLOBAL_ARTICLES_ROOM_ID, ...) like any
// other room (see SPEC2 W6), so it gets connect/peers state and persistence
// for free. This file's two jobs are (a) forwardWireToGlobal /
// forwardArticleToGlobal, used by SharedView's "forward to global" action,
// and (b) being the vendor-copy source for apps that only want to read.

import {
  getNode,
  subscribeEvent,
  isRawEvent,
  decodeRawPayload,
  storage_get,
  localNodeId,
  DELIVERY_RELIABLE,
} from "./mistClient";
import { verifyWire } from "./wireSign";
import {
  GLOBAL_ARTICLES_ROOM_ID,
  appendWireLog,
  loadWireLog,
  type ArticleWire,
  type HistoryRequestWire,
  type NewsWire,
} from "./newsWire";
import type { NewsArticle } from "../types";

// Mirrors useNewsRoom.ts's replay pacing so a peer that only joins the
// global room (via this reader) behaves the same as a private-room peer.
const HISTORY_ANSWER_THROTTLE_MS = 60_000;
const HISTORY_REQUEST_DELAY_MS = 700;
const REPLAY_STAGGER_MS = 40;

function isArticleWirePayload(value: unknown): value is ArticleWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:article" &&
    typeof v.id === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.cid === "string" &&
    typeof v.signature === "string" &&
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

function isHistoryRequestPayload(value: unknown): value is HistoryRequestWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tc-news:history-request" && typeof v.fromId === "string" && typeof v.timestamp === "number";
}

function sanitizeArticleCandidate(value: unknown): NewsArticle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  if (typeof v.title !== "string") return null;
  if (typeof v.body !== "string") return null;
  if (typeof v.authorDid !== "string") return null;
  if (typeof v.createdAt !== "number") return null;
  return {
    id: v.id,
    title: v.title,
    excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
    body: v.body,
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
    sourceLinks: Array.isArray(v.sourceLinks)
      ? v.sourceLinks.filter(
          (s): s is { title: string; url: string } =>
            !!s && typeof s === "object" && typeof (s as Record<string, unknown>).title === "string" && typeof (s as Record<string, unknown>).url === "string",
        )
      : [],
    authorDid: v.authorDid,
    authorName: typeof v.authorName === "string" ? v.authorName : "",
    createdAt: v.createdAt,
    cid: typeof v.cid === "string" ? v.cid : undefined,
    shared: typeof v.shared === "boolean" ? v.shared : undefined,
    lang: typeof v.lang === "string" && v.lang ? v.lang : undefined,
    imageUrl: typeof v.imageUrl === "string" && v.imageUrl ? v.imageUrl : undefined,
  };
}

/**
 * 購読専用: グローバル記事ルームに参加し、検証済みの記事を受け取る。
 * Persistence of received articles is the caller's responsibility — this
 * function only verifies and decodes. Returns an unsubscribe function that
 * also leaves the room.
 */
export function subscribeGlobalArticles(onArticle: (article: NewsArticle, wire: ArticleWire) => void): () => void {
  let cancelled = false;
  const roomId = GLOBAL_ARTICLES_ROOM_ID;
  const answeredAt = new Map<string, number>();
  // Dedupe within this subscription's lifetime only (no persisted list here
  // — the caller owns storage, per this function's contract).
  const seenIds = new Set<string>();

  async function hydrate(wire: ArticleWire) {
    try {
      if (seenIds.has(wire.id)) return; // duplicate, ignore
      if (!(await verifyWire(wire))) {
        console.warn("discarding global article wire with invalid signature", wire.id);
        return;
      }
      appendWireLog(roomId, wire);
      const bytes = await storage_get(wire.cid);
      if (cancelled) return;
      const candidate = sanitizeArticleCandidate(JSON.parse(new TextDecoder().decode(bytes)));
      if (!candidate) return;
      if (candidate.authorDid !== wire.fromId) {
        console.warn("discarding global article wire: authorDid does not match wire fromId", wire.id);
        return;
      }
      if (seenIds.has(candidate.id)) return; // duplicate, ignore
      seenIds.add(candidate.id);
      onArticle({ ...candidate, shared: true }, wire);
    } catch (err) {
      console.error("failed to hydrate global article", err);
    }
  }

  function replayHistoryTo(requesterId: string) {
    const now = Date.now();
    if (now - (answeredAt.get(requesterId) ?? 0) < HISTORY_ANSWER_THROTTLE_MS) return;
    answeredAt.set(requesterId, now);
    const log = loadWireLog(roomId);
    if (log.length === 0) return;
    getNode().then((node) => {
      log.forEach((wire, index) => {
        setTimeout(() => {
          if (cancelled) return;
          node.sendMessage(requesterId, wire, DELIVERY_RELIABLE, roomId);
        }, index * REPLAY_STAGGER_MS);
      });
    });
  }

  const unsubscribe = subscribeEvent((eventType, fromId, payload, evtRoomId) => {
    if (cancelled) return;
    if (!isRawEvent(eventType)) return;
    if (evtRoomId && evtRoomId !== roomId) return; // not this room's traffic
    const decoded = decodeRawPayload(payload);
    if (isArticleWirePayload(decoded)) {
      hydrate(decoded);
    } else if (isHistoryRequestPayload(decoded)) {
      replayHistoryTo(fromId);
    }
  });

  let historyRequestTimer: ReturnType<typeof setTimeout> | undefined;

  (async () => {
    try {
      const node = await getNode();
      if (cancelled) return;
      await node.joinRoomAsync(roomId);
      if (cancelled) return;
      historyRequestTimer = setTimeout(() => {
        if (cancelled) return;
        const request: HistoryRequestWire = {
          type: "tc-news:history-request",
          fromId: localNodeId(),
          timestamp: Date.now(),
        };
        node.sendMessage(null, request, DELIVERY_RELIABLE, roomId);
      }, HISTORY_REQUEST_DELAY_MS);
    } catch (err) {
      console.error("failed to join global articles room", err);
    }
  })();

  return () => {
    cancelled = true;
    if (historyRequestTimer) clearTimeout(historyRequestTimer);
    unsubscribe();
    getNode()
      .then((node) => node.leaveRoom(roomId))
      .catch(() => {});
  };
}

/**
 * 受信済みwireを署名を変えずグローバルルームへ再送(転送)する。再送前にverifyWireで検証し、
 * 失敗したらfalse。成功時はグローバルルームのwireLog(appendWireLog(GLOBAL_ARTICLES_ROOM_ID, wire))
 * にも記録してtrue。ArticleWire/TranslationWireいずれも同じ検証・再送ロジックで扱える(署名対象は
 * どちらも「signature以外の全フィールド」なので分岐不要)。
 */
export async function forwardWireToGlobal(wire: NewsWire): Promise<boolean> {
  if (!(await verifyWire(wire))) return false;
  try {
    const node = await getNode();
    node.sendMessage(null, wire, DELIVERY_RELIABLE, GLOBAL_ARTICLES_ROOM_ID);
    appendWireLog(GLOBAL_ARTICLES_ROOM_ID, wire);
    return true;
  } catch (err) {
    console.error("failed to forward wire to global room", err);
    return false;
  }
}

/**
 * SharedViewの「グローバルへ転送」用: 記事idからfromRoomIdのwireLogを引き、該当wireを
 * forwardWireToGlobalする。見つからなければfalse。
 */
export async function forwardArticleToGlobal(articleId: string, fromRoomId: string): Promise<boolean> {
  const wire = loadWireLog(fromRoomId).find((w) => w.id === articleId);
  if (!wire) return false;
  return forwardWireToGlobal(wire);
}
