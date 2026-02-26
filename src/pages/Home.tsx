import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createRoom, joinRoom, normalizeRoomCode } from "../firebase";

export default function Home() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();

  const [name, setName] = useState(() => localStorage.getItem("pp_name") || "");
  // Pre-fill room code from ?code= query param (e.g. redirected from a direct room link)
  const [code, setCode] = useState(() => {
    const param = searchParams.get("code");
    return param ? param.toUpperCase().slice(0, 4) : "";
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canProceed = useMemo(() => name.trim().length > 0, [name]);

  async function onCreate() {
    setErr(null);
    if (!canProceed) return;
    setBusy(true);
    try {
      localStorage.setItem("pp_name", name.trim());
      const roomCode = await createRoom({ name });
      // Pass { joined: true } so Room.tsx knows this navigation came from within the app
      nav(`/room/${roomCode}`, { state: { joined: true } });
    } catch (e: any) {
      setErr(e?.message || "Failed to create room.");
    } finally {
      setBusy(false);
    }
  }

  async function onJoin() {
    setErr(null);
    if (!canProceed) return;
    setBusy(true);
    try {
      localStorage.setItem("pp_name", name.trim());
      const roomCode = normalizeRoomCode(code);
      await joinRoom({ code: roomCode, name });
      // Pass { joined: true } so Room.tsx knows this navigation came from within the app
      nav(`/room/${roomCode}`, { state: { joined: true } });
    } catch (e: any) {
      setErr(e?.message || "Failed to join room.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <h1>Planning Poker</h1>
        <p className="muted">Anonymous sign-in. Join with a 4-character code.</p>

        <label className="label">Your name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Alex"
          autoComplete="off"
        />

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={!canProceed || busy} onClick={onCreate}>
            Create room
          </button>
        </div>

        <hr className="hr" />

        <label className="label">Room code</label>
        <input
          className="input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="AB12"
          autoComplete="off"
          maxLength={4}
        />

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!canProceed || busy || code.trim().length !== 4} onClick={onJoin}>
            Join room
          </button>
        </div>

        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}
