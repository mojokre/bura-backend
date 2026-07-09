import { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { supabaseAdmin } from "../lib/supabase.js";
import { markUserActive } from "../services/presence.service.js";
import { getUserGameRoomId, getUsersInGameRoom } from "../services/tables.service.js";

type SocketPayload = Record<string, unknown>;

let io: Server | null = null;
const socketsByUser = new Map<string, Set<string>>();
const userBySocket = new Map<string, string>();
/** socketId → voice roomId */
const voiceRoomBySocket = new Map<string, string>();

export function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on("connection", async (socket) => {
    const token = getToken(socket.handshake.auth);
    if (!token) {
      socket.disconnect(true);
      return;
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      socket.disconnect(true);
      return;
    }

    const userId = data.user.id;
    const current = socketsByUser.get(userId) ?? new Set<string>();
    current.add(socket.id);
    socketsByUser.set(userId, current);
    userBySocket.set(socket.id, userId);
    socket.join(userId);
    markUserActive(userId);

    socket.on("presence:ping", () => {
      markUserActive(userId);
    });

    registerVoiceHandlers(socket, userId);
    registerChatHandlers(socket, userId);

    socket.on("disconnect", () => {
      leaveVoiceRoom(socket, userId);
      userBySocket.delete(socket.id);
      const set = socketsByUser.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        socketsByUser.delete(userId);
      }
    });
  });
}

function voiceChannel(roomId: string) {
  return `voice:${roomId}`;
}

function registerVoiceHandlers(socket: Socket, userId: string) {
  socket.on("voice:join", (payload: unknown) => {
    const roomId =
      payload && typeof payload === "object"
        ? (payload as { roomId?: unknown }).roomId
        : null;
    if (typeof roomId !== "string" || !roomId) return;

    const activeRoom = getUserGameRoomId(userId);
    if (activeRoom !== roomId) {
      socket.emit("voice:error", { message: "ამ ოთახში ხმა ვერ ჩაირთვება." });
      return;
    }

    // Leave previous voice room if any
    leaveVoiceRoom(socket, userId);

    const channel = voiceChannel(roomId);
    const peers = getUsersInGameRoom(roomId).filter((id) => id !== userId);

    // Who is already in the voice channel (from socket rooms)
    const alreadyInVoice: string[] = [];
    const room = io?.sockets.adapter.rooms.get(channel);
    if (room) {
      for (const sid of room) {
        const uid = userBySocket.get(sid);
        if (uid && uid !== userId && !alreadyInVoice.includes(uid)) {
          alreadyInVoice.push(uid);
        }
      }
    }

    void socket.join(channel);
    voiceRoomBySocket.set(socket.id, roomId);

    socket.emit("voice:peers", { roomId, peers: alreadyInVoice });
    socket.to(channel).emit("voice:peer-joined", { roomId, userId });

    // Soft check — still allow if somehow empty peer list from game map
    void peers;
  });

  socket.on("voice:leave", () => {
    leaveVoiceRoom(socket, userId);
  });

  socket.on("voice:signal", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const body = payload as {
      roomId?: unknown;
      toUserId?: unknown;
      data?: unknown;
    };
    if (typeof body.roomId !== "string" || typeof body.toUserId !== "string") {
      return;
    }
    if (body.data === undefined) return;

    const myRoom = voiceRoomBySocket.get(socket.id);
    if (myRoom !== body.roomId) return;
    if (getUserGameRoomId(body.toUserId) !== body.roomId) return;

    emitToUser(body.toUserId, "voice:signal", {
      roomId: body.roomId,
      fromUserId: userId,
      data: body.data,
    });
  });
}

function registerChatHandlers(socket: Socket, userId: string) {
  socket.on("game:chat", (payload: unknown) => {
    const raw =
      payload && typeof payload === "object"
        ? (payload as { text?: unknown }).text
        : null;
    if (typeof raw !== "string") return;
    const text = raw.trim().slice(0, 60);
    if (!text) return;

    const roomId = getUserGameRoomId(userId);
    if (!roomId) return;

    const members = getUsersInGameRoom(roomId);
    const ts = Date.now();
    for (const uid of members) {
      emitToUser(uid, "game:chat", { roomId, userId, text, ts });
    }
  });
}

function leaveVoiceRoom(socket: Socket, userId: string) {
  const roomId = voiceRoomBySocket.get(socket.id);
  if (!roomId) return;
  const channel = voiceChannel(roomId);
  void socket.leave(channel);
  voiceRoomBySocket.delete(socket.id);
  socket.to(channel).emit("voice:peer-left", { roomId, userId });
}

function getToken(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function emitToUser(userId: string, event: string, payload: SocketPayload = {}) {
  if (!io) return;
  io.to(userId).emit(event, payload);
}

/** True if this user currently has at least one live socket connection. */
export function isUserConnectedRealtime(userId: string): boolean {
  const set = socketsByUser.get(userId);
  return Boolean(set && set.size > 0);
}

export function emitBroadcast(event: string, payload: SocketPayload = {}) {
  if (!io) return;
  io.emit(event, payload);
}
