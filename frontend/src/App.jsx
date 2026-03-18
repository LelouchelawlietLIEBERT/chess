import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io } from "socket.io-client";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:3001";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(ms) {
  const s = Math.max(0, Math.ceil((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function kingSquare(chess, color) {
  for (const row of chess.board())
    for (const sq of row)
      if (sq?.type === "k" && sq.color === color) return sq.square;
  return null;
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function Clock({ ms, active, low }) {
  return (
    <div style={{
      fontFamily: "'Courier New', monospace", fontSize: 22,
      fontVariantNumeric: "tabular-nums", letterSpacing: 2,
      padding: "6px 14px", borderRadius: 6, minWidth: 74, textAlign: "center",
      background: active ? "rgba(200,169,110,0.12)" : "rgba(0,0,0,0.2)",
      border: `1px solid ${active ? "#c8a96e" : "#2e2820"}`,
      color: low ? "#e05252" : active ? "#c8a96e" : "#6b5f4b",
      transition: "all 0.3s",
    }}>{fmt(ms)}</div>
  );
}

// ─── Player Row ───────────────────────────────────────────────────────────────
function PlayerRow({ name, isMe, active, ms, low }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 14px", borderRadius: 7, transition: "all 0.2s",
      background: active ? "#1e1a16" : "#131210",
      border: `1px solid ${active ? "#3a3228" : "#1c1812"}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {active && <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: "#c8a96e", boxShadow: "0 0 8px #c8a96e",
          animation: "blink 1.2s ease-in-out infinite",
        }} />}
        <span style={{ fontStyle: "italic", fontSize: 14, color: active ? "#e8e0d0" : "#6b5f4b" }}>
          {name}{isMe && <span style={{ color: "#4a4035", marginLeft: 6 }}>(you)</span>}
        </span>
      </div>
      <Clock ms={ms} active={active} low={low} />
    </div>
  );
}

// ─── Move History ─────────────────────────────────────────────────────────────
function MoveHistory({ history }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [history]);

  const pairs = [];
  for (let i = 0; i < history.length; i += 2)
    pairs.push({ n: i / 2 + 1, w: history[i], b: history[i + 1] });

  return (
    <div style={{
      background: "#0f0e0c", border: "1px solid #1e1a16", borderRadius: 7,
      padding: "8px 6px", overflowY: "auto", flex: 1, minHeight: 0,
    }} ref={ref}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: "#4a4035",
        textTransform: "uppercase", padding: "0 6px 6px", borderBottom: "1px solid #1a1612", marginBottom: 4 }}>
        Moves
      </div>
      {pairs.length === 0
        ? <div style={{ color: "#2e2820", fontSize: 12, padding: "6px 8px", fontStyle: "italic" }}>No moves yet…</div>
        : pairs.map(p => (
          <div key={p.n} style={{
            display: "grid", gridTemplateColumns: "26px 1fr 1fr",
            gap: 2, padding: "2px 4px", borderRadius: 3,
          }}>
            <span style={{ fontSize: 11, color: "#3a3228", paddingTop: 2 }}>{p.n}.</span>
            <span style={{ fontSize: 13, color: "#c8a96e", padding: "2px 6px", borderRadius: 3,
              background: "rgba(200,169,110,0.07)" }}>{p.w}</span>
            {p.b
              ? <span style={{ fontSize: 13, color: "#9a8a72", padding: "2px 6px" }}>{p.b}</span>
              : <span />}
          </div>
        ))}
    </div>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function Chat({ messages, onSend, myName }) {
  const [input, setInput] = useState("");
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages]);

  const send = () => {
    const txt = input.trim();
    if (!txt) return;
    onSend(txt); setInput("");
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "#0f0e0c", border: "1px solid #1e1a16",
      borderRadius: 7, overflow: "hidden", height: 190, flexShrink: 0,
    }}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: "#4a4035", textTransform: "uppercase",
        padding: "7px 10px 5px", borderBottom: "1px solid #1a1612" }}>Chat</div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px",
        display: "flex", flexDirection: "column", gap: 5 }} ref={ref}>
        {messages.length === 0
          ? <div style={{ color: "#2e2820", fontSize: 12, fontStyle: "italic" }}>No messages yet…</div>
          : messages.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start",
              flexDirection: m.from === myName ? "row-reverse" : "row" }}>
              <span style={{ fontSize: 10, color: "#4a4035", whiteSpace: "nowrap", paddingTop: 3 }}>{m.from}</span>
              <span style={{
                fontSize: 13, padding: "3px 9px", borderRadius: 10, maxWidth: "72%", wordBreak: "break-word",
                color: m.from === myName ? "#c8a96e" : "#a09080",
                background: m.from === myName ? "rgba(200,169,110,0.08)" : "rgba(255,255,255,0.04)",
              }}>{m.text}</span>
            </div>
          ))}
      </div>
      <div style={{ display: "flex", borderTop: "1px solid #1a1612" }}>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Say something…" maxLength={120}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none",
            color: "#b8a98a", fontSize: 13, padding: "8px 10px", fontFamily: "inherit" }} />
        <button onClick={send} style={{ background: "transparent", border: "none",
          cursor: "pointer", color: "#4a4035", fontSize: 16, padding: "0 12px" }}
          onMouseEnter={e => e.currentTarget.style.color = "#c8a96e"}
          onMouseLeave={e => e.currentTarget.style.color = "#4a4035"}>➤</button>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const socketRef = useRef(null);
  const chessRef  = useRef(new Chess());

  const [phase,        setPhase]        = useState("lobby");
  const [selectedTC,   setSelectedTC]   = useState(5);
  const [roomId,       setRoomId]       = useState(null);
  const [myColor,      setMyColor]      = useState("w");
  const [myName,       setMyName]       = useState("");
  const [opponentName, setOpponentName] = useState("");
  const [fen,          setFen]          = useState("start");
  const [turn,         setTurn]         = useState("w");
  const [clocks,       setClocks]       = useState({ w: 300000, b: 300000 });
  // *** history stored independently — never derived from chess.history() after .load() ***
  const [history,      setHistory]      = useState([]);
  const [lastMove,     setLastMove]     = useState(null);
  const [gameOver,     setGameOver]     = useState(null);
  const [status,       setStatus]       = useState("");
  const [drawOffered,  setDrawOffered]  = useState(false);
  const [chatMessages, setChatMessages] = useState([]);

  // Click-to-move
  const [selectedSq,       setSelectedSq]       = useState(null);
  const [optionSquares,    setOptionSquares]    = useState({});

  // Promotion picker: { from, to, isPremove? } when awaiting piece choice
  const [pendingPromo,     setPendingPromo]     = useState(null);

  // Premove state
  const [premove,       setPremove]       = useState(null);   // { from, to, promotion? }
  const [premoveSq,     setPremoveSq]     = useState(null);   // first square of pending premove click

  // ─── Socket ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("assignedName", ({ name }) => setMyName(name));
    socket.on("waitingForOpponent", () => setPhase("waiting"));
    socket.on("queueCancelled",     () => setPhase("lobby"));

    socket.on("gameStart", (data) => {
      chessRef.current = new Chess();
      setRoomId(data.roomId);
      setMyColor(data.color);
      setOpponentName(data.opponentName);
      if (data.myName) setMyName(data.myName);
      setFen(data.fen);
      setTurn(data.turn || "w");
      setClocks(data.clocks);
      setHistory([]);
      setLastMove(null);
      setGameOver(null);
      setDrawOffered(false);
      setSelectedSq(null);
      setOptionSquares({});
      setPremove(null);
      setPremoveSq(null);
      setChatMessages([]);
      setStatus(`${data.timeControl}m · ${data.color === "w" ? "You play White" : "You play Black"}`);
      setPhase("game");
    });

    socket.on("moveUpdate", (data) => {
      // data: { fen, turn, move, clocks, san, history }
      chessRef.current.load(data.fen);
      setFen(data.fen);
      setTurn(data.turn);
      setClocks(data.clocks);

      // *** Use server-sent history array if present, else append san locally ***
      if (Array.isArray(data.history)) {
        setHistory(data.history);
      } else if (data.san) {
        setHistory(prev => [...prev, data.san]);
      }

      if (data.move) setLastMove({ from: data.move.from, to: data.move.to });
      setSelectedSq(null);
      setOptionSquares({});

      // ── Fire queued premove if it's now our turn ──────────────────────────
      // We use a ref trick: read premove from a ref so the closure is fresh
    });

    socket.on("clockUpdate", ({ clocks }) => setClocks({ ...clocks }));

    socket.on("moveRejected", ({ reason }) => {
      setStatus(`⚠ ${reason}`);
      setPremove(null);
      setPremoveSq(null);
      setSelectedSq(null);
      setOptionSquares({});
    });

    socket.on("gameOver", ({ reason, winner, winnerName, clocks }) => {
      if (clocks) setClocks(clocks);
      setGameOver({ reason, winner, winnerName });
      setPremove(null);
      setPremoveSq(null);
      setPhase("ended");
    });

    socket.on("chatMessage", ({ from, text }) => {
      setChatMessages(prev => [...prev, { from, text }]);
    });

    socket.on("drawOffered",  () => setDrawOffered(true));
    socket.on("drawDeclined", () => setStatus("Draw declined."));

    return () => socket.disconnect();
  }, []);

  // ─── Premove fire effect ─────────────────────────────────────────────────────
  // When turn changes to myColor and there's a queued premove, fire it
  const premoveRef = useRef(null);
  const roomIdRef  = useRef(null);
  const myColorRef = useRef("w");

  useEffect(() => { premoveRef.current = premove; },   [premove]);
  useEffect(() => { roomIdRef.current  = roomId;  },   [roomId]);
  useEffect(() => { myColorRef.current = myColor; },   [myColor]);

  useEffect(() => {
    if (turn !== myColor) return;
    const pm = premoveRef.current;
    if (!pm) return;

    // Validate premove is still legal on the new position
    const chess = chessRef.current;
    const legal = chess.moves({ verbose: true }).some(m => m.from === pm.from && m.to === pm.to);

    setPremove(null);
    setPremoveSq(null);

    if (legal) {
      socketRef.current?.emit("makeMove", {
        roomId: roomIdRef.current,
        move: pm,
      });
    }
  }, [turn]); // intentionally only re-runs when turn changes

  // ─── Move hints ─────────────────────────────────────────────────────────────
  const getMoveOptions = useCallback((square) => {
    const moves = chessRef.current.moves({ square, verbose: true });
    if (!moves.length) return {};
    const styles = {};
    moves.forEach(m => {
      const isCapture = !!chessRef.current.get(m.to)?.type;
      styles[m.to] = isCapture
        ? { background: "radial-gradient(circle, transparent 55%, rgba(220,50,50,0.55) 56%)", borderRadius: "50%" }
        : { background: "radial-gradient(circle, rgba(200,169,110,0.75) 26%, transparent 27%)", borderRadius: "50%" };
    });
    return styles;
  }, []);

  // ─── Square click handler ────────────────────────────────────────────────────
  const onSquareClick = useCallback((square) => {
    if (phase !== "game") return;
    const chess = chessRef.current;
    const isMyTurnNow = turn === myColor;

    // ── It's MY turn: normal click-to-move ──────────────────────────────────
    if (isMyTurnNow) {
      if (selectedSq) {
        const moves = chess.moves({ square: selectedSq, verbose: true });
        const target = moves.find(m => m.to === square);
        if (target) {
          const isPromo = target.piece === "p" &&
            ((myColor === "w" && square[1] === "8") || (myColor === "b" && square[1] === "1"));
          if (isPromo) {
            setPendingPromo({ from: selectedSq, to: square });
            setSelectedSq(null); setOptionSquares({});
          } else {
            socketRef.current?.emit("makeMove", { roomId, move: { from: selectedSq, to: square } });
            setSelectedSq(null); setOptionSquares({});
          }
          return;
        }
      }
      const piece = chess.get(square);
      if (piece && piece.color === myColor) {
        setSelectedSq(square);
        setOptionSquares(getMoveOptions(square));
      } else {
        setSelectedSq(null); setOptionSquares({});
      }
      return;
    }

    // ── NOT my turn: set premove via click ──────────────────────────────────
    if (premoveSq) {
      // Second click — confirm premove
      const piece = chess.get(premoveSq);
      if (!piece || piece.color !== myColor) {
        setPremoveSq(null); setPremove(null); return;
      }
      const isPromo = piece.type === "p" &&
        ((myColor === "w" && square[1] === "8") || (myColor === "b" && square[1] === "1"));
      if (isPromo) {
        setPendingPromo({ from: premoveSq, to: square, isPremove: true });
        setPremoveSq(null);
      } else {
        setPremove({ from: premoveSq, to: square });
        setPremoveSq(null);
      }
    } else {
      // First click — must be our own piece
      const piece = chess.get(square);
      if (piece && piece.color === myColor) {
        setPremoveSq(square);
        setPremove(null);
      }
    }
  }, [phase, turn, myColor, selectedSq, premoveSq, roomId, getMoveOptions]);

  // ─── Drag-and-drop ──────────────────────────────────────────────────────────
  const onPieceDrop = useCallback((from, to, piece) => {
    const chess = chessRef.current;
    const isMyTurnNow = turn === myColor;

    if (isMyTurnNow) {
      // Validate locally before sending
      const legal = chess.moves({ verbose: true }).some(m => m.from === from && m.to === to);
      if (!legal) return false;
      const isPromo = piece[1] === "P" &&
        ((myColor === "w" && to[1] === "8") || (myColor === "b" && to[1] === "1"));
      if (isPromo) {
        setPendingPromo({ from, to });
        return false; // hold board until piece chosen
      }
      socketRef.current?.emit("makeMove", { roomId, move: { from, to } });
      return true;
    } else {
      // Drag premove — any of our pieces to anywhere (premove always promotes to queen)
      const p = chess.get(from);
      if (!p || p.color !== myColor) return false;
      const isPromo = piece[1] === "P" &&
        ((myColor === "w" && to[1] === "8") || (myColor === "b" && to[1] === "1"));
      if (isPromo) {
        setPendingPromo({ from, to, isPremove: true });
      } else {
        setPremove({ from, to });
      }
      setPremoveSq(null);
      return false;
    }
  }, [turn, myColor, roomId]);

  // ─── Cancel premove ──────────────────────────────────────────────────────────
  const cancelPremove = () => { setPremove(null); setPremoveSq(null); };

  // ─── Confirm promotion piece ─────────────────────────────────────────────────
  const confirmPromotion = (piece) => {
    if (!pendingPromo) return;
    if (pendingPromo.isPremove) {
      // Queue as premove with chosen piece
      setPremove({ from: pendingPromo.from, to: pendingPromo.to, promotion: piece });
    } else {
      // Fire immediately
      socketRef.current?.emit("makeMove", { roomId, move: { from: pendingPromo.from, to: pendingPromo.to, promotion: piece } });
    }
    setPendingPromo(null);
  };
  const cancelPromotion = () => setPendingPromo(null);

  // ─── Chat ────────────────────────────────────────────────────────────────────
  const sendChat = useCallback((text) => {
    socketRef.current?.emit("chatMessage", { roomId, text });
    setChatMessages(prev => [...prev, { from: myName, text }]);
  }, [roomId, myName]);

  // ─── Game actions ────────────────────────────────────────────────────────────
  const findGame   = () => { socketRef.current?.emit("findGame", { timeControl: selectedTC }); setPhase("waiting"); };
  const cancelQ    = () => socketRef.current?.emit("cancelQueue");
  const resign     = () => { if (window.confirm("Resign?")) socketRef.current?.emit("resign", { roomId }); };
  const offerDraw  = () => { socketRef.current?.emit("offerDraw", { roomId }); setStatus("Draw offered…"); };
  const acceptDraw = () => { socketRef.current?.emit("acceptDraw", { roomId }); setDrawOffered(false); };
  const declineDraw= () => { socketRef.current?.emit("declineDraw", { roomId }); setDrawOffered(false); };
  const playAgain  = () => { setPhase("lobby"); setGameOver(null); setFen("start"); chessRef.current = new Chess(); };

  // ─── Square styles ───────────────────────────────────────────────────────────
  const chess   = chessRef.current;
  const oppColor= myColor === "w" ? "b" : "w";
  const isMyTurn= phase === "game" && turn === myColor;
  const inCheck = phase === "game" && chess.inCheck();
  const kingPos = inCheck ? kingSquare(chess, turn) : null;
  const myMs    = clocks[myColor] ?? 0;
  const oppMs   = clocks[oppColor] ?? 0;

  const sqStyles = { ...optionSquares };
  if (lastMove) {
    sqStyles[lastMove.from] = { ...sqStyles[lastMove.from], backgroundColor: "rgba(200,169,110,0.28)" };
    sqStyles[lastMove.to]   = { ...sqStyles[lastMove.to],   backgroundColor: "rgba(200,169,110,0.45)" };
  }
  if (selectedSq) {
    sqStyles[selectedSq] = { ...sqStyles[selectedSq],
      backgroundColor: "rgba(200,169,110,0.55)",
      boxShadow: "inset 0 0 0 3px rgba(200,169,110,0.85)",
    };
  }
  if (kingPos) {
    sqStyles[kingPos] = { ...sqStyles[kingPos],
      background: "radial-gradient(circle, #c0392b 0%, rgba(192,57,43,0.55) 50%, transparent 72%)",
      boxShadow: "inset 0 0 0 2px rgba(220,50,50,0.9)",
    };
  }
  // Premove highlights — blue tint
  if (premoveSq) {
    sqStyles[premoveSq] = { ...sqStyles[premoveSq],
      backgroundColor: "rgba(80,140,220,0.55)",
      boxShadow: "inset 0 0 0 3px rgba(80,140,220,0.9)",
    };
  }
  if (premove) {
    sqStyles[premove.from] = { ...sqStyles[premove.from], backgroundColor: "rgba(80,140,220,0.35)" };
    sqStyles[premove.to]   = { ...sqStyles[premove.to],   backgroundColor: "rgba(80,140,220,0.55)" };
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d0d0f; }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes blink   { 0%,100%{ opacity:1; } 50%{ opacity:0.25; } }
        @keyframes checkGlow {
          0%,100% { box-shadow: 0 0 0 2px rgba(220,50,50,0.4), 0 20px 60px rgba(0,0,0,0.8); }
          50%     { box-shadow: 0 0 20px 4px rgba(220,50,50,0.7), 0 20px 60px rgba(0,0,0,0.8); }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2e2820; border-radius: 2px; }
      `}</style>

      <div style={{ minHeight: "100vh", background: "#0d0d0f", color: "#e8e0d0",
        fontFamily: "'IM Fell English', Georgia, serif",
        display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 16px" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28,
          fontSize: 12, letterSpacing: 4, color: "#4a4035", textTransform: "uppercase" }}>
          <div style={{ width: 60, height: 1, background: "linear-gradient(90deg,transparent,#3a3228)" }} />
          ♟ Chess Arena
          <div style={{ width: 60, height: 1, background: "linear-gradient(90deg,#3a3228,transparent)" }} />
        </div>

        {/* ── LOBBY ─────────────────────────────────────────────────────────── */}
        {phase === "lobby" && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:24, maxWidth:360, width:"100%" }}>
            <h1 style={{ fontSize:44, fontWeight:400, color:"#e8e0d0", textAlign:"center", lineHeight:1.1 }}>Find a Game</h1>
            <p style={{ fontSize:12, color:"#4a4035", letterSpacing:3, textTransform:"uppercase" }}>Real-time · Server validated</p>
            {myName && (
              <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:6,
                padding:"10px 20px", fontSize:14, color:"#b8a98a", fontStyle:"italic" }}>
                Playing as: {myName}
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, width:"100%" }}>
              {[1,3,5,10].map(tc => (
                <button key={tc} onClick={() => setSelectedTC(tc)} style={{
                  background: selectedTC===tc ? "#c8a96e" : "#1a1714",
                  border: `1px solid ${selectedTC===tc ? "#c8a96e" : "#2e2820"}`,
                  color: selectedTC===tc ? "#0d0d0f" : "#b8a98a",
                  borderRadius:6, padding:14, fontSize:18, fontFamily:"inherit",
                  cursor:"pointer", transition:"all 0.15s",
                  display:"flex", flexDirection:"column", alignItems:"center", gap:2,
                }}>
                  {tc}
                  <span style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase" }}>min</span>
                </button>
              ))}
            </div>
            <button onClick={findGame} style={{
              width:"100%", padding:16,
              background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
              border:"none", borderRadius:6, color:"#0d0d0f",
              fontSize:13, letterSpacing:3, textTransform:"uppercase",
              fontFamily:"inherit", cursor:"pointer",
            }}>Find Opponent</button>
          </div>
        )}

        {/* ── WAITING ───────────────────────────────────────────────────────── */}
        {phase === "waiting" && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:20, color:"#b8a98a" }}>
            <div style={{ width:40, height:40, border:"2px solid #2e2820",
              borderTop:"2px solid #c8a96e", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
            <p>Seeking opponent for {selectedTC}min…</p>
            <button onClick={cancelQ} style={{ background:"transparent", border:"1px solid #2e2820",
              color:"#6b5f4b", padding:"10px 24px", borderRadius:6,
              cursor:"pointer", fontFamily:"inherit", fontSize:13, letterSpacing:2 }}>Cancel</button>
          </div>
        )}

        {/* ── GAME ──────────────────────────────────────────────────────────── */}
        {(phase === "game" || phase === "ended") && (
          <div style={{ display:"flex", gap:16, alignItems:"flex-start", width:"100%", maxWidth:920 }}>

            {/* Board column */}
            <div style={{ display:"flex", flexDirection:"column", gap:8, flexShrink:0, width:"min(520px,100vw - 32px)" }}>

              <PlayerRow name={opponentName} isMe={false}
                active={turn===oppColor && phase==="game"} ms={oppMs} low={oppMs<10000} />

              {/* Board wrapper */}
              <div style={{
                borderRadius:4, overflow:"hidden",
                boxShadow: inCheck && turn===myColor
                  ? "0 0 0 3px rgba(220,50,50,0.7), 0 20px 60px rgba(0,0,0,0.8)"
                  : "0 20px 60px rgba(0,0,0,0.8), 0 0 0 1px #2e2820",
                animation: inCheck && turn===myColor ? "checkGlow 1.5s ease-in-out infinite" : "none",
              }}>
                <Chessboard
                  position={fen}
                  onPieceDrop={onPieceDrop}
                  onSquareClick={onSquareClick}
                  boardOrientation={myColor==="w" ? "white" : "black"}
                  arePiecesDraggable={phase==="game"}
                  customSquareStyles={sqStyles}
                  customDarkSquareStyle={{ backgroundColor:"#5a4a3a" }}
                  customLightSquareStyle={{ backgroundColor:"#d4c5a9" }}
                  customBoardStyle={{ borderRadius:0 }}
                  animationDuration={120}
                />
              </div>

              <PlayerRow name={myName} isMe={true}
                active={isMyTurn} ms={myMs} low={myMs<10000} />

              {/* Status / premove bar */}
              <div style={{ minHeight:26, display:"flex", alignItems:"center", justifyContent:"space-between",
                padding:"0 2px", gap:8 }}>
                <span style={{ fontSize:11, letterSpacing:2, color: inCheck&&turn===myColor ? "#e05252" : "#4a4035",
                  textTransform:"uppercase" }}>
                  {inCheck && turn===myColor ? "⚠ check"
                    : premove ? `⟳ premove: ${premove.from}→${premove.to}`
                    : premoveSq ? "select destination…"
                    : isMyTurn ? "your move"
                    : "waiting…"}
                </span>
                {(premove || premoveSq) && (
                  <button onClick={cancelPremove} style={{ background:"transparent",
                    border:"1px solid #3a3060", color:"#8080cc", fontSize:10, letterSpacing:1,
                    padding:"3px 8px", borderRadius:4, cursor:"pointer", fontFamily:"inherit",
                    textTransform:"uppercase" }}>cancel premove</button>
                )}
              </div>

              {drawOffered && (
                <div style={{ display:"flex", alignItems:"center", gap:10,
                  background:"#1e1a16", border:"1px solid #3a3228", borderRadius:7,
                  padding:"10px 14px", fontSize:13, color:"#b8a98a" }}>
                  <span style={{ flex:1 }}>Opponent offers a draw</span>
                  <button onClick={acceptDraw}  style={gBtn()}>Accept</button>
                  <button onClick={declineDraw} style={gBtn("danger")}>Decline</button>
                </div>
              )}

              {phase === "game" && (
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={offerDraw} style={gBtn()}>Offer Draw</button>
                  <button onClick={resign}    style={gBtn("danger")}>Resign</button>
                </div>
              )}
            </div>

            {/* Side panel: moves + chat */}
            <div style={{ flex:1, display:"flex", flexDirection:"column", gap:10,
              minWidth:0, alignSelf:"stretch", minHeight:0 }}>
              <MoveHistory history={history} />
              <Chat messages={chatMessages} onSend={sendChat} myName={myName} />
            </div>
          </div>
        )}

        {/* ── PROMOTION PICKER ────────────────────────────────────────────────── */}
        {pendingPromo && (
          <div style={{
            position:"fixed", inset:0, background:"rgba(0,0,0,0.72)",
            display:"flex", alignItems:"center", justifyContent:"center",
            zIndex:200, backdropFilter:"blur(6px)",
          }} onClick={cancelPromotion}>
            <div style={{
              background:"#1a1714", border:"1px solid #3a3228", borderRadius:12,
              padding:"32px 28px", display:"flex", flexDirection:"column",
              alignItems:"center", gap:18,
            }} onClick={e => e.stopPropagation()}>
              <p style={{ fontSize:13, letterSpacing:3, textTransform:"uppercase", color:"#6b5f4b" }}>
                {pendingPromo?.isPremove ? "Premove — promote to" : "Promote to"}
              </p>
              <div style={{ display:"flex", gap:12 }}>
                {[
                  { piece:"q", label:"Queen",  sym: myColor==="w" ? "♕" : "♛" },
                  { piece:"r", label:"Rook",   sym: myColor==="w" ? "♖" : "♜" },
                  { piece:"b", label:"Bishop", sym: myColor==="w" ? "♗" : "♝" },
                  { piece:"n", label:"Knight", sym: myColor==="w" ? "♘" : "♞" },
                ].map(({ piece, label, sym }) => (
                  <button key={piece} onClick={() => confirmPromotion(piece)} style={{
                    display:"flex", flexDirection:"column", alignItems:"center", gap:6,
                    background:"#201d1a", border:"1px solid #3a3228", borderRadius:10,
                    padding:"16px 20px", cursor:"pointer", transition:"all 0.15s",
                    color:"#e8e0d0", fontFamily:"inherit",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor="#c8a96e"; e.currentTarget.style.background="rgba(200,169,110,0.1)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="#3a3228"; e.currentTarget.style.background="#201d1a"; }}>
                    <span style={{ fontSize:44, lineHeight:1 }}>{sym}</span>
                    <span style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase", color:"#6b5f4b" }}>{label}</span>
                  </button>
                ))}
              </div>
              <button onClick={cancelPromotion} style={{
                background:"transparent", border:"none", color:"#4a4035",
                fontSize:11, letterSpacing:2, textTransform:"uppercase",
                cursor:"pointer", fontFamily:"inherit", marginTop:-4,
              }}>cancel</button>
            </div>
          </div>
        )}

        {/* ── GAME OVER OVERLAY ─────────────────────────────────────────────── */}
        {phase === "ended" && gameOver && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)",
            display:"flex", alignItems:"center", justifyContent:"center",
            zIndex:100, backdropFilter:"blur(4px)" }}>
            <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:12,
              padding:"44px 40px", textAlign:"center", maxWidth:320, width:"90%",
              display:"flex", flexDirection:"column", gap:14 }}>
              {gameOver.winner === null ? (
                <><div style={{ fontSize:52 }}>½</div>
                  <h2 style={{ fontSize:30, fontWeight:400 }}>Draw</h2>
                  <p style={{ fontSize:12, color:"#6b5f4b", letterSpacing:2, textTransform:"uppercase" }}>{gameOver.reason}</p></>
              ) : gameOver.winner === myColor ? (
                <><div style={{ fontSize:52 }}>♛</div>
                  <h2 style={{ fontSize:30, fontWeight:400, color:"#c8a96e" }}>Victory</h2>
                  <p style={{ fontSize:12, color:"#6b5f4b", letterSpacing:2, textTransform:"uppercase" }}>{gameOver.reason}</p></>
              ) : (
                <><div style={{ fontSize:52, opacity:0.4 }}>♟</div>
                  <h2 style={{ fontSize:30, fontWeight:400, color:"#6b5f4b" }}>Defeat</h2>
                  <p style={{ fontSize:12, color:"#4a4035", letterSpacing:2, textTransform:"uppercase" }}>{gameOver.reason}</p>
                  {gameOver.winnerName && <p style={{ color:"#b8a98a", fontSize:14 }}>{gameOver.winnerName} wins</p>}</>
              )}
              <button onClick={playAgain} style={{
                padding:14, background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                border:"none", borderRadius:6, color:"#0d0d0f",
                fontSize:12, letterSpacing:3, textTransform:"uppercase",
                fontFamily:"inherit", cursor:"pointer", marginTop:6,
              }}>Play Again</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function gBtn(variant) {
  return {
    padding:"8px 16px", border:`1px solid ${variant==="danger" ? "#6b2020" : "#2e2820"}`,
    borderRadius:5, background:"transparent",
    color: variant==="danger" ? "#e05252" : "#6b5f4b",
    fontSize:11, letterSpacing:2, textTransform:"uppercase",
    fontFamily:"inherit", cursor:"pointer",
  };
}