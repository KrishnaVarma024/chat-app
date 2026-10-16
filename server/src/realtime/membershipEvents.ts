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
 * This is an EDGE: it fires once, in the process that served the HTTP
 * request, and nothing repeats it. The eviction it triggers
 * (`io.in(...).socketsLeave(...)`) is cluster-wide once a shared adapter such
 * as Redis is installed, so the normal path survives scaling out. What does
 * not survive is a LOST edge - an exception between the DELETE and the
 * announce, or an instance dying in that window while another instance holds
 * the user's socket. A single instance that dies takes its sockets with it
 * (clients rejoin and join_room re-checks the database); with several, the
 * survivors keep their cached "yes". realtime/membershipSweep.ts is the
 * level-triggered backstop that bounds that staleness.
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
