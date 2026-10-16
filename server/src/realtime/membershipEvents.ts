import { EventEmitter } from 'node:events';

/**
 * A tiny in-process bus between the HTTP layer and the socket layer.
 *
 * The problem it solves: in v1, "is this user still a member?" was asked on
 * every request, so leaving a room cut access on the very next poll. In v2 a
 * socket that has joined `room:7` keeps receiving room 7's pushes until
 * something removes it from that Socket.IO room — and the thing that knows a
 * membership just ended is an HTTP route, which has no handle on the socket
 * server. Rather than make routes import Socket.IO (and drag a transport
 * dependency into the REST layer), the route announces a fact —
 * "(user, room) membership ended" — and the socket layer, which already owns
 * the live rooms, subscribes and evicts. Dependencies point inward: routes
 * -> this module <- sockets.
 *
 * Process-local on purpose, exactly like presence and room fan-out (see
 * ARCHITECTURE_V2.md §12): with more than one instance, this announcement
 * has to travel through the same shared layer (the Redis adapter) as
 * everything else, or the instance that served the HTTP request would be the
 * only one to evict.
 */
export interface MembershipRevoked {
  roomId: number;
  userId: number;
}

const bus = new EventEmitter();

export function announceMembershipRevoked(event: MembershipRevoked): void {
  bus.emit('revoked', event);
}

/** Subscribes; returns an unsubscribe function. */
export function onMembershipRevoked(listener: (event: MembershipRevoked) => void): () => void {
  bus.on('revoked', listener);
  return () => {
    bus.off('revoked', listener);
  };
}
