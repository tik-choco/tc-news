// P2P sharing of NewsArticle records over a mistlib room. Simplified port of
// tc-chat's usePostStream + useHistorySync for a single "article" wire kind:
// article bodies are content-addressed via storage_add() and only the CID +
// metadata travel on the signed wire (see lib/newsWire.ts).
import { useEffect, useRef, useState } from "preact/hooks";
import {
  getNode,
  subscribeEvent,
  isRawEvent,
  decodeRawPayload,
  storage_add,
  storage_get,
  DELIVERY_RELIABLE,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
} from "../lib/mistClient";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { signWireFields, verifyWire } from "../lib/wireSign";
import {
  appendProgramLog,
  appendReactionLog,
  appendWireLog,
  isProgramWire,
  isReactionWire,
  loadProgramLog,
  loadReactionLog,
  loadSharedArticles,
  loadSharedPrograms,
  loadWireLog,
  newReactionWireId,
  newTranslationWireId,
  sanitizeSharedProgram,
  saveSharedArticles,
  saveSharedPrograms,
  type ArticleWire,
  type HistoryRequestWire,
  type ProgramWire,
  type ReactionWire,
  type TranslationWire,
} from "../lib/newsWire";
import { addReaction } from "../lib/reactionStore";
import { getTranslation, saveTranslation, type ArticleTranslation } from "../lib/translationStore";
import { REACTION_KINDS, type NewsArticle, type RadioProgram, type ReactionKind } from "../types";

// Same-requester replay throttle: a peer that keeps re-broadcasting
// history-request (e.g. on repeated reconnects) only gets replayed to once
// per window, so a flaky link can't trigger a replay storm.
const HISTORY_ANSWER_THROTTLE_MS = 60_000;
// Per-peer throttle for the *re-request* sent on EVENT_PEER_CONNECTED (see
// below): distinct from HISTORY_ANSWER_THROTTLE_MS, which throttles us
// answering others' requests. This throttles us asking the same peer again.
const HISTORY_REREQUEST_THROTTLE_MS = 60_000;
// Ask once shortly after the room finishes joining, giving the article
// subscriber above time to mount so replayed wires aren't missed.
const HISTORY_REQUEST_DELAY_MS = 700;
// Stagger replayed wires so a large wire log doesn't burst all at once.
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
    // fromApp is optional (back-compat with pre-fromApp wires); if present it
    // must be a string. Not required — we don't gate receipt on it.
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

function isHistoryRequestPayload(value: unknown): value is HistoryRequestWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tc-news:history-request" && typeof v.fromId === "string" && typeof v.timestamp === "number";
}

function isTranslationWirePayload(value: unknown): value is TranslationWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:translation" &&
    typeof v.id === "string" &&
    typeof v.articleId === "string" &&
    typeof v.lang === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.cid === "string" &&
    typeof v.signature === "string" &&
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

function sanitizeTranslationPayload(
  value: unknown,
): { articleId: string; lang: string; title: string; excerpt: string; body: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.articleId !== "string" || !v.articleId) return null;
  if (typeof v.lang !== "string" || !v.lang) return null;
  if (typeof v.title !== "string") return null;
  if (typeof v.body !== "string") return null;
  return {
    articleId: v.articleId,
    lang: v.lang,
    title: v.title,
    excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
    body: v.body,
  };
}

function sanitizeSharedArticleCandidate(value: unknown): NewsArticle | null {
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
    category: typeof v.category === "string" && v.category ? v.category : undefined,
    lang: typeof v.lang === "string" && v.lang ? v.lang : undefined,
    imageUrl: typeof v.imageUrl === "string" && v.imageUrl ? v.imageUrl : undefined,
  };
}

export function useNewsRoom(roomId: string, userName: string, enabled = true) {
  const [sharedArticles, setSharedArticles] = useState<NewsArticle[]>([]);
  const [sharedPrograms, setSharedPrograms] = useState<RadioProgram[]>([]);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState(0);

  const sharedArticlesRef = useRef<NewsArticle[]>([]);
  const sharedProgramsRef = useRef<RadioProgram[]>([]);
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  const userNameRef = useRef(userName);
  userNameRef.current = userName;

  useEffect(() => {
    if (!enabled) {
      // Caller (app.tsx) uses this to avoid double-joining the global room
      // when the private room *is* the global room. Do nothing: no
      // join/subscribe, and reset to the disconnected/empty shape.
      setSharedArticles([]);
      sharedArticlesRef.current = [];
      setSharedPrograms([]);
      sharedProgramsRef.current = [];
      setConnected(false);
      setPeers(0);
      return;
    }
    setSharedArticles([]);
    sharedArticlesRef.current = [];
    setSharedPrograms([]);
    sharedProgramsRef.current = [];
    setConnected(false);
    setPeers(0);
    const peerIds = new Set<string>();

    let cancelled = false;

    // loadSharedArticles/loadSharedPrograms now read through the mist KV
    // (lib/kvStore.ts's kvGetOrMigrate), so this initial load is async and
    // can in principle resolve after a wire has already hydrated something
    // into sharedArticlesRef/sharedProgramsRef below (a fast local KV read
    // racing a network wire is unlikely, but not impossible) — merge rather
    // than overwrite so a same-session hydrate never gets clobbered by the
    // slightly-stale load it raced.
    Promise.all([loadSharedArticles(roomId), loadSharedPrograms(roomId)]).then(([articles, programs]) => {
      if (cancelled) return;
      const mergedArticles = [
        ...sharedArticlesRef.current,
        ...articles.filter((a) => !sharedArticlesRef.current.some((x) => x.id === a.id)),
      ];
      sharedArticlesRef.current = mergedArticles;
      setSharedArticles(mergedArticles);
      const mergedPrograms = [
        ...sharedProgramsRef.current,
        ...programs.filter((p) => !sharedProgramsRef.current.some((x) => x.id === p.id)),
      ];
      sharedProgramsRef.current = mergedPrograms;
      setSharedPrograms(mergedPrograms);
    });
    // The swarm topic is the raw room id itself — no derived/obscured
    // channel id, so any peer joining the same room name lands in the same
    // swarm.
    const channelId = roomId;
    const answeredAt = new Map<string, number>();
    // Per-peer throttle for the targeted history re-request sent on
    // EVENT_PEER_CONNECTED (see below).
    const requestedAt = new Map<string, number>();

    function commitSharedArticles(next: NewsArticle[]) {
      sharedArticlesRef.current = next;
      saveSharedArticles(roomId, next);
      setSharedArticles(next);
    }

    function commitSharedPrograms(next: RadioProgram[]) {
      sharedProgramsRef.current = next;
      saveSharedPrograms(roomId, next);
      setSharedPrograms(next);
    }

    async function hydrateArticle(wire: ArticleWire) {
      try {
        if (sharedArticlesRef.current.some((a) => a.id === wire.id)) return; // duplicate, ignore
        if (!(await verifyWire(wire))) {
          console.warn("discarding article wire with invalid signature", wire.id);
          return;
        }
        appendWireLog(roomId, wire);
        const bytes = await storage_get(wire.cid);
        if (cancelled) return;
        const candidate = sanitizeSharedArticleCandidate(JSON.parse(new TextDecoder().decode(bytes)));
        if (!candidate) return;
        if (candidate.authorDid !== wire.fromId) {
          console.warn("discarding article wire: authorDid does not match wire fromId", wire.id);
          return;
        }
        if (sharedArticlesRef.current.some((a) => a.id === candidate.id)) return; // duplicate, ignore
        commitSharedArticles([{ ...candidate, shared: true }, ...sharedArticlesRef.current]);
      } catch (err) {
        console.error("failed to hydrate shared article", err);
      }
    }

    async function hydrateTranslation(wire: TranslationWire) {
      try {
        if (getTranslation(wire.articleId, wire.lang)) return; // already have one, skip the fetch entirely
        if (!(await verifyWire(wire))) {
          console.warn("discarding translation wire with invalid signature", wire.id);
          return;
        }
        appendWireLog(roomId, wire);
        const bytes = await storage_get(wire.cid);
        if (cancelled) return;
        const candidate = sanitizeTranslationPayload(JSON.parse(new TextDecoder().decode(bytes)));
        if (!candidate) return;
        if (candidate.articleId !== wire.articleId || candidate.lang !== wire.lang) return;
        if (getTranslation(wire.articleId, wire.lang)) return; // race: another wire's content landed first
        saveTranslation({
          id: wire.id,
          articleId: wire.articleId,
          lang: wire.lang,
          title: candidate.title,
          excerpt: candidate.excerpt,
          body: candidate.body,
          translatorDid: wire.fromId,
          translatorName: wire.fromName,
          translatedAt: wire.timestamp,
          cid: wire.cid,
        });
      } catch (err) {
        console.error("failed to hydrate translation", err);
      }
    }

    // Program wires mirror hydrateArticle's CID fetch + authorDid==fromId
    // check. They're excluded from newsWire.ts's NewsWire union (and thus
    // appendWireLog/loadWireLog — see that file's header comment), but they
    // do get their own dedicated replay log (loadProgramLog/appendProgramLog)
    // so late joiners still receive them via replayHistoryTo below.
    async function hydrateProgram(wire: ProgramWire) {
      try {
        if (sharedProgramsRef.current.some((p) => p.id === wire.id)) return; // duplicate, ignore
        if (!(await verifyWire(wire))) {
          console.warn("discarding program wire with invalid signature", wire.id);
          return;
        }
        appendProgramLog(roomId, wire);
        const bytes = await storage_get(wire.cid);
        if (cancelled) return;
        const candidate = sanitizeSharedProgram(JSON.parse(new TextDecoder().decode(bytes)));
        if (!candidate) return;
        if (candidate.authorDid !== wire.fromId) {
          console.warn("discarding program wire: authorDid does not match wire fromId", wire.id);
          return;
        }
        if (sharedProgramsRef.current.some((p) => p.id === candidate.id)) return; // duplicate, ignore
        commitSharedPrograms([{ ...candidate }, ...sharedProgramsRef.current]);
      } catch (err) {
        console.error("failed to hydrate shared program", err);
      }
    }

    // Reactions carry no CID — the wire *is* the payload. The wire guard only
    // checks kind is a string (so unknown future kinds don't break wire
    // validation); membership in REACTION_KINDS is the semantic check here.
    // reactionStore.addReaction dedups by (targetId, kind, fromId), and only
    // a genuinely-new reaction is appended to the (separate) reaction log for
    // replay to newcomers.
    async function hydrateReaction(wire: ReactionWire) {
      try {
        if (!(await verifyWire(wire))) {
          console.warn("discarding reaction wire with invalid signature", wire.id);
          return;
        }
        if (cancelled) return;
        if (!(REACTION_KINDS as readonly string[]).includes(wire.kind)) return; // unknown kind, ignore
        if (wire.targetType !== "article" && wire.targetType !== "program") return;
        const isNew = addReaction({
          targetId: wire.targetId,
          targetType: wire.targetType,
          kind: wire.kind as ReactionKind,
          fromId: wire.fromId,
          fromName: wire.fromName,
          timestamp: wire.timestamp,
        });
        if (isNew) appendReactionLog(roomId, wire);
      } catch (err) {
        console.error("failed to apply reaction wire", err);
      }
    }

    function replayHistoryTo(requesterId: string) {
      const now = Date.now();
      if (now - (answeredAt.get(requesterId) ?? 0) < HISTORY_ANSWER_THROTTLE_MS) return;
      answeredAt.set(requesterId, now);
      const log = loadWireLog(roomId);
      // Reaction wires live in their own log (see newsWire.ts) but ride the
      // same staggered replay: the reaction indices continue after the wire
      // log's so the two logs don't burst onto the link at the same time.
      const reactionLog = loadReactionLog(roomId);
      // Program wires also live in their own log (see hydrateProgram above)
      // and ride the same staggered replay, continuing after both the wire
      // log and reaction log so none of the three bursts onto the link at
      // once.
      const programLog = loadProgramLog(roomId);
      if (log.length === 0 && reactionLog.length === 0 && programLog.length === 0) return;
      getNode().then((node) => {
        log.forEach((wire, index) => {
          setTimeout(() => {
            if (cancelled) return;
            node.sendMessage(requesterId, wire, DELIVERY_RELIABLE, channelId);
          }, index * REPLAY_STAGGER_MS);
        });
        reactionLog.forEach((wire, index) => {
          setTimeout(() => {
            if (cancelled) return;
            node.sendMessage(requesterId, wire, DELIVERY_RELIABLE, channelId);
          }, (log.length + index) * REPLAY_STAGGER_MS);
        });
        programLog.forEach((wire, index) => {
          setTimeout(() => {
            if (cancelled) return;
            node.sendMessage(requesterId, wire, DELIVERY_RELIABLE, channelId);
          }, (log.length + reactionLog.length + index) * REPLAY_STAGGER_MS);
        });
      });
    }

    const unsubscribe = subscribeEvent((eventType, fromId, payload, evtRoomId) => {
      if (cancelled) return;
      if (isRawEvent(eventType)) {
        if (evtRoomId && evtRoomId !== channelId) return; // not this room's traffic
        const decoded = decodeRawPayload(payload);
        if (isArticleWirePayload(decoded)) {
          hydrateArticle(decoded);
        } else if (isTranslationWirePayload(decoded)) {
          hydrateTranslation(decoded);
        } else if (isProgramWire(decoded)) {
          hydrateProgram(decoded);
        } else if (isReactionWire(decoded)) {
          hydrateReaction(decoded);
        } else if (isHistoryRequestPayload(decoded)) {
          replayHistoryTo(fromId);
        }
        return;
      }
      if (eventType === EVENT_PEER_CONNECTED) {
        // mistlib does not scope EVENT_PEER_CONNECTED/DISCONNECTED to a room
        // — peer ids are node-wide, not per-room (unlike EVENT_RAW, whose
        // evtRoomId we do filter on above). Confirmed by cross-checking the
        // sibling tc-chat app's usePresence.ts, which tracks peers the same
        // way and does not filter these two event types by evtRoomId either.
        // So this stays a global peer count, matching prior behavior
        // (conservative: not narrowing scope without a confirmed room field).
        peerIds.add(fromId);
        setPeers(peerIds.size);
        // Also re-send a *targeted* history-request to this newly-connected
        // peer: the original broadcast (700ms after join, below) can fire
        // before any peer connection exists, in which case it reaches no
        // one and is never retried. Since EVENT_PEER_CONNECTED is node-wide
        // rather than room-scoped (see comment above), this may fire for
        // peers outside this room too — harmless, since the receiver's
        // evtRoomId filter above discards traffic for other rooms.
        {
          const now = Date.now();
          if (now - (requestedAt.get(fromId) ?? 0) >= HISTORY_REREQUEST_THROTTLE_MS) {
            requestedAt.set(fromId, now);
            ensureDidIdentity()
              .then((id) => {
                if (cancelled) return;
                const request: HistoryRequestWire = {
                  type: "tc-news:history-request",
                  fromId: id.did,
                  timestamp: Date.now(),
                };
                getNode()
                  .then((node) => {
                    if (cancelled) return;
                    node.sendMessage(fromId, request, DELIVERY_RELIABLE, channelId);
                  })
                  .catch((err) => console.error("failed to send targeted history request", err));
              })
              .catch((err) => console.error("failed to send targeted history request", err));
          }
        }
      } else if (eventType === EVENT_PEER_DISCONNECTED) {
        peerIds.delete(fromId);
        setPeers(peerIds.size);
      }
    });

    let historyRequestTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const node = await getNode();
        if (cancelled) return;
        await node.joinRoomAsync(roomId);
        if (cancelled) return;
        setConnected(true);
        historyRequestTimer = setTimeout(() => {
          if (cancelled) return;
          const identity = ensureDidIdentity();
          identity
            .then((id) => {
              if (cancelled) return;
              const request: HistoryRequestWire = {
                type: "tc-news:history-request",
                fromId: id.did,
                timestamp: Date.now(),
              };
              node.sendMessage(null, request, DELIVERY_RELIABLE, channelId);
            })
            .catch((err) => console.error("failed to broadcast history request", err));
        }, HISTORY_REQUEST_DELAY_MS);
      } catch (err) {
        console.error("failed to join news room", err);
        if (!cancelled) setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
      if (historyRequestTimer) clearTimeout(historyRequestTimer);
      unsubscribe();
      setConnected(false);
      getNode()
        .then((node) => node.leaveRoom(roomId))
        .catch(() => {});
    };
  }, [roomId, enabled]);

  async function share(article: NewsArticle): Promise<void> {
    const node = await getNode();
    const identity = await ensureDidIdentity();
    const cid = await storage_add(`${article.id}.json`, new TextEncoder().encode(JSON.stringify(article)));
    const unsigned = {
      type: "tc-news:article" as const,
      id: article.id,
      fromId: identity.did,
      fromName: userNameRef.current,
      timestamp: Date.now(),
      cid,
      // Publishing app, for cross-app-family provenance. wireSign signs
      // every field except `signature` symmetrically (stableStringify, not a
      // fixed enum), so adding this field here doesn't desync signing from
      // verification.
      fromApp: "tc-news",
    };
    const wire: ArticleWire = { ...unsigned, signature: await signWireFields(unsigned) };
    node.sendMessage(null, wire, DELIVERY_RELIABLE, roomIdRef.current);
    appendWireLog(roomIdRef.current, wire);
    const shared: NewsArticle = { ...article, cid, shared: true };
    const next = [shared, ...sharedArticlesRef.current.filter((a) => a.id !== article.id)];
    sharedArticlesRef.current = next;
    saveSharedArticles(roomIdRef.current, next);
    setSharedArticles(next);
  }

  async function shareTranslation(
    articleId: string,
    lang: string,
    content: { title: string; excerpt: string; body: string },
  ): Promise<ArticleTranslation> {
    const node = await getNode();
    const identity = await ensureDidIdentity();
    const cid = await storage_add(
      `${articleId}.${lang}.json`,
      new TextEncoder().encode(JSON.stringify({ articleId, lang, ...content })),
    );
    const unsigned = {
      type: "tc-news:translation" as const,
      id: newTranslationWireId(),
      articleId,
      lang,
      fromId: identity.did,
      fromName: userNameRef.current,
      timestamp: Date.now(),
      cid,
      fromApp: "tc-news",
    };
    const wire: TranslationWire = { ...unsigned, signature: await signWireFields(unsigned) };
    node.sendMessage(null, wire, DELIVERY_RELIABLE, roomIdRef.current);
    appendWireLog(roomIdRef.current, wire);
    return saveTranslation({
      id: wire.id,
      articleId,
      lang,
      title: content.title,
      excerpt: content.excerpt,
      body: content.body,
      translatorDid: identity.did,
      translatorName: userNameRef.current,
      translatedAt: wire.timestamp,
      cid,
    });
  }

  // Mirrors share(): the full RadioProgram JSON is content-addressed via
  // storage_add and only CID + metadata travel on the signed wire. The
  // stamped copy (authorDid/authorName/shared) is what gets CID'd, so the
  // receiver's authorDid===fromId check can pass. Program wires are excluded
  // from the article wireLog by design (see hydrateProgram above), but are
  // appended to the dedicated programLog (appendProgramLog, symmetric with
  // share()'s appendWireLog) so they're replayed to late joiners too.
  async function shareProgram(program: RadioProgram): Promise<RadioProgram> {
    const node = await getNode();
    const identity = await ensureDidIdentity();
    const stamped: RadioProgram = {
      ...program,
      authorDid: identity.did,
      authorName: userNameRef.current,
      shared: true,
    };
    const cid = await storage_add(`${program.id}.program.json`, new TextEncoder().encode(JSON.stringify(stamped)));
    const unsigned = {
      type: "tc-news:program" as const,
      id: program.id,
      fromId: identity.did,
      fromName: userNameRef.current,
      timestamp: Date.now(),
      cid,
      fromApp: "tc-news",
    };
    const wire: ProgramWire = { ...unsigned, signature: await signWireFields(unsigned) };
    node.sendMessage(null, wire, DELIVERY_RELIABLE, roomIdRef.current);
    appendProgramLog(roomIdRef.current, wire);
    const next = [stamped, ...sharedProgramsRef.current.filter((p) => p.id !== program.id)];
    sharedProgramsRef.current = next;
    saveSharedPrograms(roomIdRef.current, next);
    setSharedPrograms(next);
    return stamped;
  }

  // A reaction wire is self-contained (no CID hop). It goes on the wire, into
  // the room's reaction replay log, and straight into the local reactionStore
  // so the sender's own UI tally updates without waiting for an echo.
  async function sendReaction(
    targetId: string,
    targetType: "article" | "program",
    kind: ReactionKind,
  ): Promise<void> {
    const node = await getNode();
    const identity = await ensureDidIdentity();
    const unsigned = {
      type: "tc-news:reaction" as const,
      id: newReactionWireId(),
      targetId,
      targetType,
      kind,
      fromId: identity.did,
      fromName: userNameRef.current,
      timestamp: Date.now(),
      fromApp: "tc-news",
    };
    const wire: ReactionWire = { ...unsigned, signature: await signWireFields(unsigned) };
    node.sendMessage(null, wire, DELIVERY_RELIABLE, roomIdRef.current);
    appendReactionLog(roomIdRef.current, wire);
    addReaction({
      targetId,
      targetType,
      kind,
      fromId: identity.did,
      fromName: userNameRef.current,
      timestamp: unsigned.timestamp,
    });
  }

  return { sharedArticles, sharedPrograms, share, shareTranslation, shareProgram, sendReaction, connected, peers };
}
