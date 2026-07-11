// App-side wiring for @tik-choco/mistai's AI Network consumer: injects the
// vendored mistlib node into the shared ConsumerClient so tc-news can send
// its LLM requests to a provider peer in a room instead of (or alongside)
// a direct OpenAI-compatible endpoint. Ported from tc-town's src/lib/network.ts
// with the provider-hook re-exports dropped — tc-news is consumer-only for now.

import { ConsumerClient, type ConsumerStatus, type ConsumerStatusListener, type MistNodeLike } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
import { getNode, subscribeEvent, NODE_ID_STORAGE_KEY } from "./mistClient";

type RealMistNode = Awaited<ReturnType<typeof getNode>>;

/**
 * MistNodeLike adapter around mistClient's shared singleton MistNode.
 *
 * mistlib-wasm allows only one active MistNode per page (see
 * src/lib/mistClient.ts's header comment), but @tik-choco/mistai's `Network`
 * class is designed to own a dedicated node per session: it calls
 * `createNode(nodeId)` on every join, sets the node's single onEvent()
 * handler, and tears the node down via parameterless leaveRoom() on
 * disconnect. Handing it the shared node directly would clobber mistClient's
 * event dispatcher and deinitialize the node out from under the news rooms.
 *
 * This adapter is what `createMistNode` returns instead: a lightweight
 * per-session object that
 *  - resolves the one real node via mistClient's getNode() (idempotent),
 *  - subscribes to mistClient's fan-out (subscribeEvent) rather than
 *    replacing the node's onEvent() handler, filtering to only the room
 *    this adapter joined,
 *  - leaves only its own room by always passing an explicit roomId to the
 *    real node's leaveRoom(), never the page-wide parameterless form.
 */
class SharedMistNode implements MistNodeLike {
  private realNode: RealMistNode | null = null;
  private roomId: string | null = null;
  private joinPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  async init(): Promise<void> {
    this.realNode = await getNode();
  }

  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void {
    this.unsubscribe?.();
    this.unsubscribe = subscribeEvent((eventType, fromId, payload, roomId) => {
      if (this.roomId !== null && roomId !== this.roomId) return;
      handler(eventType, fromId, payload);
    });
  }

  joinRoom(roomId: string): void {
    this.roomId = roomId;
    // ConsumerClient broadcasts a consumer_hello as soon as this (void)
    // method returns, but the wasm node rejects sendMessage for a room whose
    // session isn't built yet ("Room not joined"). Join with the awaitable
    // variant and let sendMessage() below queue behind it.
    this.joinPromise = this.realNode
      ? this.realNode.joinRoomAsync(roomId).catch((err: unknown) => {
          console.warn("tc-news: AI Network room join failed", err);
        })
      : null;
  }

  leaveRoom(): void {
    const roomId = this.roomId;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.roomId = null;
    this.joinPromise = null;
    // Explicit roomId only: the real node's parameterless leaveRoom() fully
    // deinitializes the shared node (see mistClient.ts), which would break
    // the news rooms still using it.
    if (roomId) this.realNode?.leaveRoom(roomId);
  }

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    const node = this.realNode;
    const roomId = this.roomId;
    if (!node || roomId === null) return;
    const send = () => {
      // Dropped if the session left the room while the join was in flight.
      if (this.roomId !== roomId) return;
      node.sendMessage(toId, payload, delivery, roomId);
    };
    if (this.joinPromise) void this.joinPromise.then(send);
    else send();
  }
}

/**
 * Factory the shared ConsumerClient uses to build a mist node. The incoming
 * `nodeId` is intentionally unused: the real shared node's identity is fixed
 * by mistClient's localNodeId(), which reads the same NODE_ID_STORAGE_KEY the
 * caller resolves `nodeId` from, so the ids always agree.
 */
export function createMistNode(_nodeId: string): MistNodeLike {
  return new SharedMistNode();
}

// A single long-lived client, keyed by room id internally.
export const networkClient = new ConsumerClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
});

export type { ConsumerStatus, ConsumerStatusListener };

/** Subscribes to consumer connection status changes. Returns an unsubscribe function. */
export function onConsumerStatusChange(listener: ConsumerStatusListener): () => void {
  return networkClient.onStatusChange(listener);
}

/** Current consumer connection status (idle/joining/searching/connected/error). */
export function consumerStatus(): ConsumerStatus {
  return networkClient.status;
}

/** Eagerly connects to the AI Network room; errors surface via status, never thrown. */
export function connectNetworkConsumer(roomId: string): Promise<void> {
  return networkClient.connect(roomId);
}

/** Tears down the active/pending consumer session and resets status to idle. */
export function disconnectNetworkConsumer(): void {
  networkClient.disconnect();
}

/** Sends a chat request over the AI Network room and resolves with the full reply text. */
export function requestNetworkChat(
  roomId: string,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  return networkClient.requestChat(roomId, messages, { model, onDelta });
}
