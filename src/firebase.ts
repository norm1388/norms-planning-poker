import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  serverTimestamp,
  doc,
  setDoc,
  updateDoc,
  collection,
  addDoc,
  deleteDoc,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export async function ensureAnonAuth(): Promise<User> {
  const current = auth.currentUser;
  if (current) return current;

  return await new Promise<User>((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (u) {
          unsub();
          resolve(u);
          return;
        }
        // Anonymous auth creates a temporary account with a UID :contentReference[oaicite:6]{index=6}
        const cred = await signInAnonymously(auth);
        unsub();
        resolve(cred.user);
      } catch (e) {
        unsub();
        reject(e);
      }
    });
  });
}

export type RoomDoc = {
  code: string;
  createdAt: unknown;
  createdBy: string;
  currentRoundId: string | null;
  updatedAt: unknown;
};

export type ParticipantDoc = {
  uid: string;
  name: string;
  joinedAt: unknown;
  lastSeenAt: unknown;
};

export type RoundDoc = {
  createdAt: unknown;
  createdBy: string;
  ticket: string;
  revealed: boolean;
};

export type VoteDoc = {
  uid: string;
  value: number; // 0,1,2,3,5,8,13
  createdAt: unknown;
};

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid ambiguous 0/O, 1/I
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function createRoom(params: { name: string }): Promise<string> {
  const user = await ensureAnonAuth();

  // Retry a few times in the very unlikely event of a room-code collision
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode();

    const roomRef = doc(db, "rooms", code);
    const participantRef = doc(db, "rooms", code, "participants", user.uid);

    const room: RoomDoc = {
      code,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      currentRoundId: null,
      updatedAt: serverTimestamp(),
    };

    const participant: ParticipantDoc = {
      uid: user.uid,
      name: params.name.trim() || "Guest",
      joinedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    };

    try {
      // 1) Create room doc first
      await setDoc(roomRef, room);

      // 2) Then create participant doc (now exists(room) will be true)
      await setDoc(participantRef, participant, { merge: true });

      return code;
    } catch (e: any) {
      // If the code collided with an existing room, setDoc(roomRef, ...) may be treated
      // as an update and fail rules -> retry with a new code.
      const msg = String(e?.message || "");
      if (msg.includes("Missing or insufficient permissions") && attempt < 9) {
        continue;
      }
      throw e;
    }
  }

  throw new Error("Failed to create a unique room code. Please try again.");
}


export async function joinRoom(params: { code: string; name: string }): Promise<void> {
  const user = await ensureAnonAuth();
  const code = normalizeRoomCode(params.code);

  const participantRef = doc(db, "rooms", code, "participants", user.uid);
  const participant: ParticipantDoc = {
    uid: user.uid,
    name: params.name.trim() || "Guest",
    joinedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  };

  try {
    // Rules require the room to exist; if it doesn't, this will fail with permission denied.
    await setDoc(participantRef, participant, { merge: true });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("Missing or insufficient permissions")) {
      throw new Error("Room not found.");
    }
    throw e;
  }
}


export async function touchPresence(code: string): Promise<void> {
  const user = await ensureAnonAuth();
  const participantRef = doc(db, "rooms", normalizeRoomCode(code), "participants", user.uid);
  await setDoc(
    participantRef,
    { lastSeenAt: serverTimestamp() },
    { merge: true }
  );
}

export async function leaveRoom(code: string): Promise<void> {
  const user = await ensureAnonAuth();
  const participantRef = doc(db, "rooms", normalizeRoomCode(code), "participants", user.uid);
  await deleteDoc(participantRef);
}

export async function startRound(params: { code: string; ticket: string }): Promise<string> {
  const user = await ensureAnonAuth();
  const code = normalizeRoomCode(params.code);

  const roundsRef = collection(db, "rooms", code, "rounds");
  const roundRef = await addDoc(roundsRef, {
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    ticket: params.ticket.trim(),
    revealed: false,
  } satisfies RoundDoc);

  const roomRef = doc(db, "rooms", code);
  await updateDoc(roomRef, {
    currentRoundId: roundRef.id,
    updatedAt: serverTimestamp(),
  });

  return roundRef.id;
}

export async function revealRound(params: { code: string; roundId: string }): Promise<void> {
  const code = normalizeRoomCode(params.code);
  const roundRef = doc(db, "rooms", code, "rounds", params.roundId);
  await updateDoc(roundRef, { revealed: true });
}

export async function clearCurrentRound(params: { code: string }): Promise<void> {
  const code = normalizeRoomCode(params.code);
  const roomRef = doc(db, "rooms", code);
  await updateDoc(roomRef, {
    currentRoundId: null,
    updatedAt: serverTimestamp(),
  });
}

export async function castVote(params: { code: string; roundId: string; value: number }): Promise<void> {
  const user = await ensureAnonAuth();
  const code = normalizeRoomCode(params.code);

  const voteRef = doc(db, "rooms", code, "rounds", params.roundId, "votes", user.uid);
  await setDoc(voteRef, {
    uid: user.uid,
    value: params.value,
    createdAt: serverTimestamp(),
  } satisfies VoteDoc);
}
