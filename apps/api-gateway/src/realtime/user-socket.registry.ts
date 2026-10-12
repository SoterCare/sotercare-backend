import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Owns the userId → socket ids map and the namespace server, so publishers
 * can emit to users without depending on RealtimeGateway (avoids a provider
 * cycle gateway → dispatcher → publisher → gateway).
 */
@Injectable()
export class UserSocketRegistry {
  private server: Server | null = null;
  private readonly userSockets = new Map<number, Set<string>>();

  attach(server: Server) {
    this.server = server;
  }

  add(userId: number, socketId: string) {
    const set = this.userSockets.get(userId) ?? new Set<string>();
    set.add(socketId);
    this.userSockets.set(userId, set);
  }

  remove(userId: number, socketId: string) {
    const set = this.userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.userSockets.delete(userId);
  }

  emitToUser(userId: number, event: string, data: unknown) {
    const sockets = this.userSockets.get(userId);
    if (!this.server || !sockets || sockets.size === 0) return;
    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, data);
    }
  }
}
