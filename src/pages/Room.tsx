import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import {
  db,
  ensureAnonAuth,
  normalizeRoomCode,
  touchPresence,
  leaveRoom,
  startRound,
  castVote,
  revealRound,
  clearCurrentRound,
  type RoomDoc,
  type RoundDoc,
  type ParticipantDoc,
  type VoteDoc,
} from "../firebase";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";

const CARD_VALUES = [0, 1, 2, 3, 5, 8, 13] as const;

export default function Room() {
  const nav = useNavigate();
  const location = useLocation();
  const params = useParams();
  const code = useMemo(() => normalizeRoomCode(params.code || ""), [params.code]);

  const [uid, setUid] = useState<string | null>(null);

  const [room, setRoom] = useState<RoomDoc | null>(null);
  const [participants, setParticipants] = useState<ParticipantDoc[]>([]);
  const [round, setRound] = useState<(RoundDoc & { id: string }) | null>(null);
  const [votes, setVotes] = useState<Map<string, VoteDoc>>(new Map());
  const [ticket, setTicket] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // If the user arrived via a direct link (no { joined: true } in navigation state),
  // redirect them to the lobby with the room code pre-filled.
  // Navigation state is never present on a hard load/direct link, only on in-app nav.
  useEffect(() => {
    const joinedViaApp = (location.state as any)?.joined === true;
    if (!joinedViaApp) {
      nav(`/?code=${code}`, { replace: true });
    }
  }, [code, location.state, nav]);

  const isOwner = useMemo(() => {
    if (!room || !uid) return false;
    return room.createdBy === uid;
  }, [room, uid]);

  const myVote = useMemo(() => {
    if (!uid) return null;
    return votes.get(uid)?.value ?? null;
  }, [votes, uid]);

  const votedUids = useMemo(() => new Set(Array.from(votes.keys())), [votes]);

  const revealed = !!round?.revealed;

  const summary = useMemo(() => {
    if (!revealed) return null;
    const vals = Array.from(votes.values()).map((v) => v.value);
    if (vals.length === 0) return { avg: null as number | null, count: 0 };

    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = sum / vals.length;
    return { avg, count: vals.length };
  }, [votes, revealed]);

  // Ensure auth + uid
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const user = await ensureAnonAuth();
        if (!mounted) return;
        setUid(user.uid);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message || "Auth failed.");
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Subscribe: room + participants + round + votes
  useEffect(() => {
    if (!code) return;

    let unsubRoom: Unsubscribe | null = null;
    let unsubParticipants: Unsubscribe | null = null;

    setErr(null);

    // Room listener
    const roomRef = doc(db, "rooms", code);
    unsubRoom = onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) {
          setErr("Room not found or you do not have access.");
          setRoom(null);
          return;
        }
        const data = snap.data() as RoomDoc;
        setRoom(data);
      },
      (e) => setErr(e?.message || "Failed to read room.")
    );

    // Participants listener
    const participantsRef = collection(db, "rooms", code, "participants");
    unsubParticipants = onSnapshot(
      query(participantsRef, orderBy("joinedAt", "asc")),
      (snap) => {
        setParticipants(snap.docs.map((d) => d.data() as ParticipantDoc));
      },
      (e) => setErr(e?.message || "Failed to read participants.")
    );

    return () => {
      unsubRoom?.();
      unsubParticipants?.();
    };
  }, [code]);

  // Round + votes listener (depends on room.currentRoundId)
  useEffect(() => {
    if (!code || !room?.currentRoundId) {
      setRound(null);
      setVotes(new Map());
      return;
    }

    let unsubRound: Unsubscribe | null = null;
    let unsubVotes: Unsubscribe | null = null;

    const roundId = room.currentRoundId;
    const roundRef = doc(db, "rooms", code, "rounds", roundId);

    unsubRound = onSnapshot(
      roundRef,
      (snap) => {
        if (!snap.exists()) {
          setRound(null);
          return;
        }
        setRound({ id: snap.id, ...(snap.data() as RoundDoc) });
      },
      (e) => setErr(e?.message || "Failed to read round.")
    );

    const votesRef = collection(db, "rooms", code, "rounds", roundId, "votes");
    unsubVotes = onSnapshot(
      votesRef,
      (snap) => {
        const m = new Map<string, VoteDoc>();
        snap.docs.forEach((d) => m.set(d.id, d.data() as VoteDoc));
        setVotes(m);
      },
      (e) => setErr(e?.message || "Failed to read votes.")
    );

    return () => {
      unsubRound?.();
      unsubVotes?.();
    };
  }, [code, room?.currentRoundId]);

  // Presence ping
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      touchPresence(code).catch(() => void 0);
    }, 15000);
    return () => clearInterval(t);
  }, [code]);

  async function onLeave() {
    try {
      await leaveRoom(code);
    } catch {
      // ignore
    } finally {
      nav("/");
    }
  }

  async function onStartRound() {
    if (!isOwner) return;
    setErr(null);
    try {
      await startRound({ code, ticket });
      setTicket("");
    } catch (e: any) {
      setErr(e?.message || "Failed to start round.");
    }
  }

  async function onReveal() {
    if (!isOwner || !round) return;
    setErr(null);
    try {
      await revealRound({ code, roundId: round.id });
    } catch (e: any) {
      setErr(e?.message || "Failed to reveal.");
    }
  }

  async function onReset() {
    if (!isOwner) return;
    setErr(null);
    try {
      await clearCurrentRound({ code });
      setVotes(new Map());
      setRound(null);
    } catch (e: any) {
      setErr(e?.message || "Failed to reset.");
    }
  }

  async function onVote(v: number) {
    if (!round || revealed) return;
    setErr(null);
    try {
      await castVote({ code, roundId: round.id, value: v });
    } catch (e: any) {
      setErr(e?.message || "Failed to vote.");
    }
  }

  return (
    <div className="page">
      <div className="card wide">
        <div className="topbar">
          <div>
            <h1>Room {code}</h1>
            <p className="muted">
              {room ? (isOwner ? "You are the host." : "Connected.") : "Connecting..."}
            </p>
          </div>
          <button className="btn secondary" onClick={onLeave}>Leave</button>
        </div>

        {err && <p className="error">{err}</p>}

        <div className="grid">
          <div className="panel">
            <h2>Participants</h2>
            <ul className="list">
              {participants.map((p) => {
                const hasVoted = round ? votedUids.has(p.uid) : false;
                return (
                  <li key={p.uid} className="listItem">
                    <span>{p.name}{p.uid === uid ? " (you)" : ""}</span>
                    {round && !revealed && (
                      <span className="pill">{hasVoted ? "Voted" : "…"}</span>
                    )}
                    {round && revealed && (
                      <span className="pill">
                        {votes.get(p.uid)?.value ?? "—"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="panel">
            <h2>Round</h2>

            {!round && (
              <div>
                <p className="muted">No active round.</p>
                {isOwner && (
                  <div style={{ marginTop: 12 }}>
                    <label className="label">Ticket / story (optional)</label>
                    <input
                      className="input"
                      value={ticket}
                      onChange={(e) => setTicket(e.target.value)}
                      placeholder="e.g., AUTH-123: Implement login"
                    />
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="btn" onClick={onStartRound}>
                        Start round
                      </button>
                    </div>
                  </div>
                )}
                {!isOwner && <p className="muted">Waiting for host to start a round.</p>}
              </div>
            )}

            {round && (
              <div>
                <p className="muted">
                  Ticket: <strong>{round.ticket || "—"}</strong>
                </p>

                <div className="row wrap" style={{ marginTop: 12 }}>
                  {CARD_VALUES.map((v) => (
                    <button
                      key={v}
                      className={"cardBtn" + (myVote === v ? " selected" : "")}
                      disabled={revealed}
                      onClick={() => onVote(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <div className="row" style={{ marginTop: 16 }}>
                  <span className="muted">
                    Votes: {votes.size}/{participants.length}
                  </span>

                  <div style={{ flex: 1 }} />

                  {isOwner && !revealed && (
                    <button className="btn" onClick={onReveal} disabled={votes.size === 0}>
                      Reveal
                    </button>
                  )}
                  {isOwner && (
                    <button className="btn secondary" onClick={onReset}>
                      New round
                    </button>
                  )}
                </div>

                {revealed && summary && (
                  <div className="summary">
                    <div><strong>Count:</strong> {summary.count}</div>
                    <div>
                      <strong>Average:</strong>{" "}
                      {summary.avg === null ? "—" : summary.avg.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <p className="muted footnote">
          Note: presence cleanup is best-effort; closing the tab may leave a participant entry until they click Leave.
        </p>
      </div>
    </div>
  );
}
