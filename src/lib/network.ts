// Attach mistai's multi-room scope to the existing news node and event dispatcher.
import { createSharedNodeScope, createRoomConsumers, type MistNodeLike } from "@tik-choco/mistai";
import { getNode, subscribeEvent, NODE_ID_STORAGE_KEY } from "./mistClient";

type NewsNode = Awaited<ReturnType<typeof getNode>>;
function newsNode(): MistNodeLike {
  let node: NewsNode;
  let unsubscribe: (() => void) | undefined;
  const joined = new Set<string>();
  return {
    async init() { node = await getNode(); },
    onEvent(handler) {
      unsubscribe?.();
      unsubscribe = subscribeEvent((type, from, payload, room) => handler(type, from, payload, room));
    },
    async joinRoom(room) { await this.joinRoomAsync!(room); },
    async joinRoomAsync(room) {
      await node.joinRoomAsync(room);
      joined.add(room);
    },
    leaveRoom(room) {
      for (const id of room ? [room] : [...joined]) {
        node?.leaveRoom(id);
        joined.delete(id);
      }
    },
    sendMessage(to, payload, delivery, room) { node.sendMessage(to, payload, delivery, room); },
  };
}

export const createMistNode = createSharedNodeScope(newsNode);
export const rooms = createRoomConsumers(createMistNode, { nodeIdStorageKey: NODE_ID_STORAGE_KEY });
