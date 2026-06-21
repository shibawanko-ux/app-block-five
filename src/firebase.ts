import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get, onValue, off, onDisconnect, serverTimestamp } from 'firebase/database';
import type { Player, PlayerCount } from './types';

const app = initializeApp({
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL:       import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
});

export const db = getDatabase(app);

// ── Room data shape ───────────────────────────────────────────────────────────
export interface RoomEvent {
  type: 'drop' | 'settle' | 'bomb' | 'start';
  player: Player;
  x?: number;           // drop: pixel X
  col?: number;         // settle/bomb: column
  row?: number;         // settle/bomb: row
  timeout?: boolean;    // settle: true if auto-dropped
  playerCount?: PlayerCount; // start event
  ts: object;           // serverTimestamp
}

export interface RoomData {
  playerCount: PlayerCount;
  hostConnected: boolean;   // p1
  p2Connected: boolean;
  p3Connected: boolean;
  p4Connected: boolean;
  lastEvent: RoomEvent | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function generateRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Create a new room as host (P1). playerCount sets how many players will join. */
export async function createRoom(playerCount: PlayerCount = 2): Promise<string> {
  const code = generateRoomCode();
  await set(ref(db, `rooms/${code}`), {
    playerCount,
    hostConnected: true,
    p2Connected: false,
    p3Connected: false,
    p4Connected: false,
    lastEvent: null,
  });
  return code;
}

/** Join an existing room. Returns the assigned player role (p2, p3, or p4). */
export async function joinRoom(code: string): Promise<Player> {
  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) throw new Error('ルームが見つかりません');
  const data = snap.val() as RoomData;
  const count: PlayerCount = data.playerCount ?? 2;

  if (!data.p2Connected) {
    await set(ref(db, `rooms/${code}/p2Connected`), true);
    return 'p2';
  }
  if (count >= 3 && !data.p3Connected) {
    await set(ref(db, `rooms/${code}/p3Connected`), true);
    return 'p3';
  }
  if (count >= 4 && !data.p4Connected) {
    await set(ref(db, `rooms/${code}/p4Connected`), true);
    return 'p4';
  }
  throw new Error('このルームは満員です');
}

/** Subscribe to room state to detect when all players have connected.
 *  cb receives (allConnected, connectedCount). */
export function subscribeAllConnected(
  code: string,
  playerCount: PlayerCount,
  cb: (allConnected: boolean, count: number) => void,
): () => void {
  const r = ref(db, `rooms/${code}`);
  onValue(r, snap => {
    if (!snap.exists()) return;
    const data = snap.val() as Partial<RoomData>;
    const n = (data.hostConnected ? 1 : 0)
      + (data.p2Connected ? 1 : 0)
      + (playerCount >= 3 && data.p3Connected ? 1 : 0)
      + (playerCount >= 4 && data.p4Connected ? 1 : 0);
    cb(n === playerCount, n);
  });
  return () => off(r);
}

/** Subscribe to connection fields for all opponents.
 *  Fires cb(role) when any opponent's connection drops to false. */
export function subscribeAnyOpponentDisconnect(
  code: string,
  myRole: Player,
  playerCount: PlayerCount,
  cb: (disconnectedRole: Player) => void,
): () => void {
  const all: Array<{ field: string; role: Player }> = [
    { field: 'hostConnected', role: 'p1' },
    { field: 'p2Connected',   role: 'p2' },
    { field: 'p3Connected',   role: 'p3' },
    { field: 'p4Connected',   role: 'p4' },
  ];
  const targets = all
    .filter(({ role }) => role !== myRole)
    .filter(({ role }) => {
      const idx = parseInt(role[1]);
      return idx <= playerCount;
    });

  const unsubs: Array<() => void> = [];
  for (const { field, role } of targets) {
    const r = ref(db, `rooms/${code}/${field}`);
    onValue(r, snap => {
      if (snap.exists() && snap.val() === false) cb(role);
    });
    unsubs.push(() => off(r));
  }
  return () => unsubs.forEach(u => u());
}

/** Send a drop event (block falling at pixel X). */
export function emitDrop(code: string, player: Player, x: number): Promise<void> {
  return set(ref(db, `rooms/${code}/lastEvent`), {
    type: 'drop', player, x, ts: serverTimestamp(),
  });
}

/** Send a settle event (block snapped to col/row). */
export function emitSettle(code: string, player: Player, col: number, row: number, timeout = false): Promise<void> {
  return set(ref(db, `rooms/${code}/lastEvent`), {
    type: 'settle', player, col, row, timeout, ts: serverTimestamp(),
  });
}

/** Send a bomb placement event. */
export function emitBomb(code: string, player: Player, col: number, row: number): Promise<void> {
  return set(ref(db, `rooms/${code}/lastEvent`), {
    type: 'bomb', player, col, row, ts: serverTimestamp(),
  });
}

/** Send the game-start event (host only). All guests use this to initialize game. */
export function emitStart(code: string, playerCount: PlayerCount): Promise<void> {
  return set(ref(db, `rooms/${code}/lastEvent`), {
    type: 'start', player: 'p1', playerCount, ts: serverTimestamp(),
  });
}

/** Subscribe to lastEvent changes. Returns unsubscribe function. */
export function subscribeEvent(
  code: string,
  cb: (event: RoomEvent) => void,
): () => void {
  const r = ref(db, `rooms/${code}/lastEvent`);
  onValue(r, snap => {
    if (snap.exists()) cb(snap.val() as RoomEvent);
  });
  return () => off(r);
}

/** Register Firebase onDisconnect hook — writes false to this player's field on drop. */
export function registerDisconnect(code: string, player: Player): void {
  const fieldMap: Record<Player, string> = {
    p1: 'hostConnected',
    p2: 'p2Connected',
    p3: 'p3Connected',
    p4: 'p4Connected',
  };
  onDisconnect(ref(db, `rooms/${code}/${fieldMap[player]}`)).set(false);
}

/** Clean up a room when the game ends / player leaves. */
export function removeRoom(code: string): Promise<void> {
  return set(ref(db, `rooms/${code}`), null);
}
