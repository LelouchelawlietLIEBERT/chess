import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io } from "socket.io-client";
import { jwtDecode } from "jwt-decode";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:8080";
const API_URL = process.env.REACT_APP_API_URL || SOCKET_URL;

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

// ─── Auth / room URL helpers ─────────────────────────────────────────────────
function loadStoredAuth() {
  const stored = localStorage.getItem("bb_token");
  if (!stored) return { token: null, user: null };
  try {
    const decoded = jwtDecode(stored);
    if (decoded.exp && decoded.exp * 1000 < Date.now()) throw new Error("expired");
    return {
      token: stored,
      user: { username: decoded.username, isGuest: !!decoded.isGuest, userId: decoded.userId },
    };
  } catch {
    localStorage.removeItem("bb_token");
    return { token: null, user: null };
  }
}

function readRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("room") || "").trim().toUpperCase();
}

// ─── Layout helpers ──────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 600) {
  const [mobile, setMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return mobile;
}

// ─── Stockfish helpers ────────────────────────────────────────────────────────
const STOCKFISH_URL = "https://stockfish.online/api/s/v2.php";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Serialise all Stockfish lookups so requests are always >= 1100ms apart.
let sfQueue = Promise.resolve();
let sfLastCall = 0;
function stockfishRequest(fen, depth) {
  const task = async () => {
    const wait = Math.max(0, 1100 - (Date.now() - sfLastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    sfLastCall = Date.now();
    // stockfish.online rejects depths below 6 even though the UI exposes an
    // "Easy" setting at depth 4. Clamp only the outbound request.
    const apiDepth = Math.max(6, Math.min(15, Number(depth) || 6));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `${STOCKFISH_URL}?fen=${encodeURIComponent(fen)}&depth=${encodeURIComponent(apiDepth)}`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`Stockfish HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("Stockfish timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };
  const run = sfQueue.then(task, task);
  sfQueue = run.catch(() => {});
  return run;
}

// The live API may return "bestmove e2e4 ponder c7c5" rather than just "e2e4".
function parseBestMove(raw) {
  if (!raw) return null;
  const token = String(raw).trim().replace(/^bestmove\s+/i, "").split(/\s+/)[0].toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) return null;
  return {
    from: token.slice(0, 2),
    to: token.slice(2, 4),
    promotion: token.length === 5 ? token[4] : undefined,
    uci: token,
  };
}

function formatEval(evaluation, mate) {
  if (mate !== null && mate !== undefined && mate !== "" && Number.isFinite(Number(mate))) {
    const n = Number(mate);
    return `${n > 0 ? "M" : "-M"}${Math.abs(n)}`;
  }
  const n = Number(evaluation);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

// Stockfish Online reports evaluation in pawns. Clamp the visual bar to ±10.
function evalToWhitePercent(evaluation, mate) {
  if (mate !== null && mate !== undefined && mate !== "" && Number.isFinite(Number(mate))) {
    return Number(mate) > 0 ? 100 : 0;
  }
  const n = Number(evaluation);
  if (!Number.isFinite(n)) return 50;
  const clamped = Math.max(-10, Math.min(10, n));
  return Math.max(5, Math.min(95, ((clamped + 10) / 20) * 100));
}

function uciToSanLine(fen, continuation, limit = 6) {
  if (!continuation) return "";
  const chess = new Chess();
  try { chess.load(fen); } catch { return ""; }
  const sans = [];
  for (const uci of String(continuation).trim().split(/\s+/).slice(0, limit)) {
    const parsed = parseBestMove(uci);
    if (!parsed) break;
    try {
      const move = chess.move({
        from: parsed.from,
        to: parsed.to,
        promotion: parsed.promotion,
      });
      if (!move) break;
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans.join(" ");
}

// ─── Export / history helpers ─────────────────────────────────────────────────
async function copyText(text) {
  if (!text) return false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(el);
    return true;
  }
}

function downloadPGN(game) {
  if (!game?.pgn) return;
  const blob = new Blob([game.pgn], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const white = String(game.white?.username || "white").replace(/[^a-z0-9_-]+/gi, "_");
  const black = String(game.black?.username || "black").replace(/[^a-z0-9_-]+/gi, "_");
  a.href = url;
  a.download = `blitzboard_${white}_vs_${black}.pgn`;
  a.click();
  URL.revokeObjectURL(url);
}

function gameUserColor(game, user) {
  if (!game || !user?.userId) return null;
  if (String(game.white?.userId) === String(user.userId)) return "w";
  if (String(game.black?.userId) === String(user.userId)) return "b";
  return null;
}

function gameUserResult(game, user) {
  const color = gameUserColor(game, user);
  if (game.result === "1/2-1/2") return "D";
  if (!color) return "?";
  if (game.result === "1-0") return color === "w" ? "W" : "L";
  if (game.result === "0-1") return color === "b" ? "W" : "L";
  return "?";
}

function formatGameDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function Clock({ ms, active, low, unlimited }) {
  return (
    <div style={{
      fontFamily: "'Courier New', monospace", fontSize: 26,
      fontVariantNumeric: "tabular-nums", letterSpacing: 2,
      padding: "6px 14px", borderRadius: 6, minWidth: 80, textAlign: "center",
      background: active ? "rgba(200,169,110,0.12)" : "rgba(0,0,0,0.2)",
      border: `1px solid ${active ? "#c8a96e" : "#2e2820"}`,
      color: low ? "#e05252" : active ? "#c8a96e" : "#6b5f4b",
      transition: "all 0.3s",
    }}>{unlimited ? "∞" : fmt(ms)}</div>
  );
}

// ─── Player Row ───────────────────────────────────────────────────────────────
function PlayerRow({ name, isMe, active, ms, low, unlimited }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 14px", borderRadius: 7, transition: "all 0.2s",
      background: active ? "#1e1a16" : "#131210",
      border: `1px solid ${active ? "#3a3228" : "#1c1812"}`,
      gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {active && <span style={{
          width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
          background: "#c8a96e", boxShadow: "0 0 8px #c8a96e",
          animation: "blink 1.2s ease-in-out infinite",
        }} />}
        <span style={{ fontStyle: "italic", fontSize: 17, color: active ? "#e8e0d0" : "#6b5f4b",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}{isMe && <span style={{ color: "#4a4035", marginLeft: 6 }}>(you)</span>}
        </span>
      </div>
      <Clock ms={ms} active={active} low={low} unlimited={unlimited} />
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
      <div style={{ fontSize: 12, letterSpacing: 2, color: "#4a4035",
        textTransform: "uppercase", padding: "0 6px 6px", borderBottom: "1px solid #1a1612", marginBottom: 4 }}>
        Moves
      </div>
      {pairs.length === 0
        ? <div style={{ color: "#2e2820", fontSize: 14, padding: "6px 8px", fontStyle: "italic" }}>No moves yet…</div>
        : pairs.map(p => (
          <div key={p.n} style={{
            display: "grid", gridTemplateColumns: "26px 1fr 1fr",
            gap: 2, padding: "2px 4px", borderRadius: 3,
          }}>
            <span style={{ fontSize: 13, color: "#3a3228", paddingTop: 2 }}>{p.n}.</span>
            <span style={{ fontSize: 15, color: "#c8a96e", padding: "2px 6px", borderRadius: 3,
              background: "rgba(200,169,110,0.07)" }}>{p.w}</span>
            {p.b
              ? <span style={{ fontSize: 15, color: "#9a8a72", padding: "2px 6px" }}>{p.b}</span>
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
      borderRadius: 7, overflow: "hidden", height: 200, flexShrink: 0,
    }}>
      <div style={{ fontSize: 12, letterSpacing: 2, color: "#4a4035", textTransform: "uppercase",
        padding: "7px 10px 5px", borderBottom: "1px solid #1a1612" }}>Chat</div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px",
        display: "flex", flexDirection: "column", gap: 5 }} ref={ref}>
        {messages.length === 0
          ? <div style={{ color: "#2e2820", fontSize: 14, fontStyle: "italic" }}>No messages yet…</div>
          : messages.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start",
              flexDirection: m.from === myName ? "row-reverse" : "row" }}>
              <span style={{ fontSize: 12, color: "#4a4035", whiteSpace: "nowrap", paddingTop: 3 }}>{m.from}</span>
              <span style={{
                fontSize: 15, padding: "3px 9px", borderRadius: 10, maxWidth: "72%", wordBreak: "break-word",
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
            color: "#b8a98a", fontSize: 15, padding: "8px 10px", fontFamily: "inherit" }} />
        <button onClick={send} style={{ background: "transparent", border: "none",
          cursor: "pointer", color: "#4a4035", fontSize: 18, padding: "0 12px" }}
          onMouseEnter={e => e.currentTarget.style.color = "#c8a96e"}
          onMouseLeave={e => e.currentTarget.style.color = "#4a4035"}>➤</button>
      </div>
    </div>
  );
}

// ─── Navigation ──────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: "home",     label: "Home",        icon: "⌂" },
  { id: "play",     label: "Play",        icon: "⚔" },
  { id: "computer", label: "vs Computer", icon: "♞" },
  { id: "analysis", label: "Analysis",    icon: "◎" },
  { id: "history",  label: "My Games",    icon: "▤" },
  { id: "friends",  label: "Friends",     icon: "♟" },
];

function NavBar({ section, onNavigate, user, onLogout, isMobile }) {
  return (
    <header style={{
      width: "100%", maxWidth: 1100, margin: "0 auto 8px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: isMobile ? 6 : 18, flexWrap: "wrap",
      padding: "12px 4px 14px", borderBottom: "1px solid #2e2820",
    }}>
      <button onClick={() => onNavigate("home")} aria-label="BlitzBoard home" style={{
        display: "flex", alignItems: "center", gap: 9, background: "transparent",
        border: "none", color: "#e8e0d0", fontFamily: "inherit", cursor: "pointer",
        padding: 0, flexShrink: 0,
      }}>
        <span style={{ fontSize: 26, color: "#c8a96e", lineHeight: 1 }}>♟</span>
        {!isMobile && (
          <span style={{ fontSize: 22, letterSpacing: 1 }}>BlitzBoard</span>
        )}
      </button>

      <nav style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
        {NAV_ITEMS.map(item => {
          const active = section === item.id;
          return (
            <button key={item.id} onClick={() => onNavigate(item.id)}
              title={item.label} aria-label={item.label}
              style={{
                background: active ? "rgba(200,169,110,0.12)" : "transparent",
                border: `1px solid ${active ? "#c8a96e" : "transparent"}`,
                borderRadius: 5, cursor: "pointer", fontFamily: "inherit",
                color: active ? "#c8a96e" : "#8a7a62",
                fontSize: 15, padding: isMobile ? "8px 9px" : "8px 11px",
                lineHeight: 1, transition: "all 0.15s",
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.color = "#c8a96e"; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.color = "#8a7a62"; }}>
              {isMobile ? <span style={{ fontSize: 17 }}>{item.icon}</span> : item.label}
            </button>
          );
        })}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {!isMobile && (
          <span style={{ fontSize: 15, color: "#6b5f4b", fontStyle: "italic",
            maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user?.username || ""}
          </span>
        )}
        {user?.isGuest && !isMobile && (
          <span style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "#4a4035" }}>guest</span>
        )}
        <button onClick={onLogout} title="Logout" aria-label="Logout" style={{
          background: "transparent", border: "1px solid #2e2820", borderRadius: 5,
          color: "#8a7a62", cursor: "pointer", fontFamily: "inherit",
          fontSize: 14, padding: isMobile ? "7px 9px" : "7px 12px",
          textTransform: "uppercase", letterSpacing: 1,
        }}>{isMobile ? "↪" : "Logout"}</button>
      </div>
    </header>
  );
}

// ─── Analysis / history visual helpers ───────────────────────────────────────
function EvalBar({ evaluation, mate, height = 200 }) {
  const whitePct = evalToWhitePercent(evaluation, mate);
  return (
    <div title={`Stockfish: ${formatEval(evaluation, mate)}`} style={{
      width: 18, height, background: "#161310", border: "1px solid #3a3228",
      borderRadius: 8, overflow: "hidden", position: "relative", flexShrink: 0,
      boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
    }}>
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        height: `${whitePct}%`,
        background: "linear-gradient(180deg,#f3ead9 0%,#d8c7a8 100%)",
        transition: "height 0.45s ease",
      }} />
      <div style={{
        position: "absolute", left: 0, right: 0, top: "50%", height: 1,
        background: "rgba(200,169,110,0.4)",
      }} />
    </div>
  );
}

function ResultBadge({ result }) {
  const palette = result === "W"
    ? { color: "#4ade80", bg: "rgba(74,222,128,0.1)", border: "#4ade80", label: "Win" }
    : result === "L"
    ? { color: "#e05252", bg: "rgba(224,82,82,0.1)", border: "#e05252", label: "Loss" }
    : { color: "#b8a98a", bg: "rgba(107,95,75,0.12)", border: "#6b5f4b", label: "Draw" };
  return (
    <span style={{
      fontSize: 12, letterSpacing: 2, textTransform: "uppercase",
      color: palette.color, background: palette.bg,
      border: `1px solid ${palette.border}`, borderRadius: 4,
      padding: "4px 8px", whiteSpace: "nowrap",
    }}>{palette.label}</span>
  );
}

function HistoryCard({ game, user, onAnalyse }) {
  const [copied, setCopied] = useState("");
  const color = gameUserColor(game, user);
  const result = gameUserResult(game, user);
  const opponent = color === "w" ? game.black : color === "b" ? game.white : null;
  const opponentName = opponent?.username
    || [game.white?.username, game.black?.username].filter(Boolean).join(" vs ")
    || "Unknown";
  const border = result === "W" ? "rgba(74,222,128,0.55)"
    : result === "L" ? "rgba(224,82,82,0.55)"
    : "#3a3228";

  const note = async (kind, text) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(""), 1800);
    }
  };

  const smallBtn = {
    padding: "7px 9px", background: "transparent", borderRadius: 4,
    border: "1px solid #3a3228", color: "#b8a98a", cursor: "pointer",
    fontFamily: "inherit", fontSize: 14, lineHeight: 1.15,
  };

  return (
    <div style={{
      background: "#1a1714", border: `1px solid ${border}`,
      borderRadius: 8, padding: 14, display: "flex", gap: 14,
      alignItems: "stretch", minWidth: 0,
    }}>
      <div style={{ flexShrink: 0, borderRadius: 4, overflow: "hidden", alignSelf: "flex-start" }}>
        <Chessboard
          position={game.finalFen || START_FEN}
          arePiecesDraggable={false}
          boardWidth={120}
          customDarkSquareStyle={{ backgroundColor: "#4a3d31" }}
          customLightSquareStyle={{ backgroundColor: "#cdbfa5" }}
          customBoardStyle={{ borderRadius: 3 }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, color: "#e8e0d0", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              vs {opponentName}
            </div>
            <div style={{ fontSize: 14, color: "#8a7a62", marginTop: 3 }}>
              {game.timeControl === "unlimited" ? "Unlimited" : `${game.timeControl} min`}
              {" · "}{formatGameDate(game.playedAt)}
            </div>
          </div>
          <ResultBadge result={result} />
        </div>

        <div style={{ fontSize: 14, color: "#6b5f4b", textTransform: "lowercase" }}>
          {game.termination || "completed"}
          {color ? ` · you played ${color === "w" ? "White" : "Black"}` : ""}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: "auto" }}>
          <button style={smallBtn} onClick={() => downloadPGN(game)}>Download PGN</button>
          <button style={smallBtn} onClick={() => note("fen", game.finalFen)}>
            {copied === "fen" ? "Copied!" : "Copy FEN"}
          </button>
          <button style={smallBtn} onClick={() => note("pgn", game.pgn)}>
            {copied === "pgn" ? "Copied!" : "Copy PGN"}
          </button>
          <button style={{ ...smallBtn, borderColor: "#c8a96e", color: "#c8a96e" }}
            onClick={() => onAnalyse(game)}>Analyse</button>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, isMobile, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between",
      gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
      <div>
        <h1 style={{ fontSize: isMobile ? 32 : 40, fontWeight: 400, lineHeight: 1.1 }}>{title}</h1>
        {subtitle && (
          <p style={{ fontSize: 12, color: "#6b5f4b", letterSpacing: 2,
            textTransform: "uppercase", marginTop: 8 }}>{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const socketRef     = useRef(null);
  const chessRef      = useRef(new Chess());
  const rollbackFenRef = useRef(null);   // snapshot before optimistic update, for rejection rollback
  const localGameSavedRef = useRef(false);
  const computerThinkingRef = useRef(false);
  const isMobile = useIsMobile();

  // ─── Auth / private room state ───────────────────────────────────────────────
  const initialAuthRef = useRef(null);
  if (initialAuthRef.current === null) initialAuthRef.current = loadStoredAuth();
  const initialRoomRef = useRef(null);
  if (initialRoomRef.current === null) initialRoomRef.current = readRoomFromUrl();

  const [token,     setToken]     = useState(initialAuthRef.current.token);
  const [authUser,  setAuthUser]  = useState(initialAuthRef.current.user);
  const [authTab,   setAuthTab]   = useState("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirm,  setAuthConfirm]  = useState("");
  const [authError,    setAuthError]    = useState("");
  const [authBusy,     setAuthBusy]     = useState(false);

  // Top-level navigation. Online play still uses `phase` internally.
  const [section, setSection] = useState(initialRoomRef.current ? "friends" : "home");
  const [gameMode, setGameMode] = useState("online"); // "online" | "computer"

  const [phase,        setPhase]        = useState(initialRoomRef.current ? "joinRoom" : "lobby");
  const [joinCode,     setJoinCode]     = useState(initialRoomRef.current);
  const [privateRoom,  setPrivateRoom]  = useState(null);
  const [roomError,    setRoomError]    = useState("");
  const [copied,       setCopied]       = useState(false);
  const [selectedTC,   setSelectedTC]   = useState(5);
  const [roomId,       setRoomId]       = useState(null);
  const [myColor,      setMyColor]      = useState("w");
  const [myName,       setMyName]       = useState("");
  const [opponentName, setOpponentName] = useState("");
  const [fen,          setFen]          = useState("start");
  const [shake,        setShake]        = useState(false);  // board shake on rejection
  const [turn,         setTurn]         = useState("w");

  // *** displayClocks is what the UI renders — ticks down locally every 100ms.
  //     clockSyncRef holds the last authoritative server snapshot + the wall-clock
  //     time it was received, so we can compute "elapsed since sync" independent
  //     of the render cycle instead of only updating when a socket event fires. ***
  const [displayClocks, setDisplayClocks] = useState({ w: 300000, b: 300000 });
  const clockSyncRef = useRef({ clocks: { w: 300000, b: 300000 }, turn: "w", ts: Date.now(), running: false });

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

  // ─── History ────────────────────────────────────────────────────────────────
  const [gameHistory,    setGameHistory]    = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError,   setHistoryError]   = useState("");

  // ─── vs Computer ────────────────────────────────────────────────────────────
  const [computerDepth,   setComputerDepth]   = useState(8);
  const [computerColor,   setComputerColor]   = useState("white");
  const [computerTC,      setComputerTC]      = useState("10");
  const [localUnlimited,  setLocalUnlimited]  = useState(false);
  const [localTC,         setLocalTC]         = useState(10);
  const [computerThinking, setComputerThinking] = useState(false);
  const [computerEval,    setComputerEval]    = useState(null);
  const [computerError,   setComputerError]   = useState("");

  // ─── In-game quick analysis ────────────────────────────────────────────────
  const [positionAnalysis, setPositionAnalysis] = useState(null);

  // ─── Analysis board ────────────────────────────────────────────────────────
  const [analysisTab,     setAnalysisTab]     = useState("import");
  const [analysisInput,   setAnalysisInput]   = useState("");
  const [analysisFens,    setAnalysisFens]    = useState([START_FEN]);
  const [analysisMoves,   setAnalysisMoves]   = useState([]);
  const [analysisPly,     setAnalysisPly]     = useState(0);
  const [analysisDepth,   setAnalysisDepth]   = useState(12);
  const [analysisEval,    setAnalysisEval]    = useState(null);
  const [analysisError,   setAnalysisError]   = useState("");
  const [analysisTitle,   setAnalysisTitle]   = useState("Starting position");

  // ─── Clock sync helper ───────────────────────────────────────────────────────
  // Call this any time we get an authoritative clocks+turn snapshot from the server
  // (gameStart, moveUpdate, clockUpdate, gameOver). It resets the "elapsed since
  // sync" baseline so local ticking stays accurate instead of drifting or freezing.
  const syncClocks = useCallback((clocks, turnColor, running) => {
    clockSyncRef.current = { clocks: { ...clocks }, turn: turnColor, ts: Date.now(), running };
    setDisplayClocks({ ...clocks });
  }, []);

  // Called on an optimistic local move, BEFORE the server confirms it. Unlike
  // syncClocks (which snaps to a fresh authoritative value), this bakes the time
  // actually spent since the last sync into the mover's clock, then flips whose
  // clock is running. Without this, flipping the active color while reusing the
  // old (pre-move) snapshot leaves the mover's own clock frozen at a stale, too-high
  // value until the server's moveUpdate arrives — which is the "extra 5-10s" bug.
  const flipClockOnMove = useCallback((newTurn) => {
    const sync = clockSyncRef.current;
    const elapsed = Date.now() - sync.ts;
    const movedColor = sync.turn;
    const newClocks = { ...sync.clocks };
    newClocks[movedColor] = Math.max(0, sync.clocks[movedColor] - elapsed);
    clockSyncRef.current = { clocks: newClocks, turn: newTurn, ts: Date.now(), running: true };
    setDisplayClocks({ ...newClocks });
  }, []);

  // ─── Game history ───────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!token) {
      setGameHistory([]);
      return;
    }
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await fetch(`${API_URL}/games/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load history");
      setGameHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      setHistoryError(err.message || "Could not load history");
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => {
    if (section === "history") fetchHistory();
  }, [section, fetchHistory]);

  // ─── Analysis setup ─────────────────────────────────────────────────────────
  const replayMoves = useCallback((sans) => {
    const chess = new Chess();
    const fens = [chess.fen()];
    const played = [];
    for (const san of Array.isArray(sans) ? sans : []) {
      try {
        const move = chess.move(san);
        if (!move) break;
        played.push(move.san);
        fens.push(chess.fen());
      } catch {
        break;
      }
    }
    return { fens, moves: played };
  }, []);

  const loadAnalysis = useCallback((fens, moves, title) => {
    setAnalysisFens(fens.length ? fens : [START_FEN]);
    setAnalysisMoves(moves);
    setAnalysisPly(Math.max(0, fens.length - 1));
    setAnalysisTitle(title || "Analysis");
    setAnalysisEval(null);
    setAnalysisError("");
  }, []);

  const openGameAnalysis = useCallback((game) => {
    const { fens, moves } = replayMoves(game?.moves || []);
    loadAnalysis(
      fens,
      moves,
      `${game?.white?.username || "White"} vs ${game?.black?.username || "Black"}`
    );
    setAnalysisTab("history");
    setSection("analysis");
  }, [replayMoves, loadAnalysis]);

  const importAnalysis = useCallback(() => {
    const text = analysisInput.trim();
    if (!text) {
      setAnalysisError("Paste a PGN or FEN first.");
      return;
    }

    const fields = text.split(/\s+/);
    const looksLikeFen = fields.length >= 2 && /^[rnbqkpRNBQKP1-8/]+$/.test(fields[0]);
    if (looksLikeFen) {
      const chess = new Chess();
      try {
        chess.load(text);
      } catch {
        setAnalysisError("That FEN is not valid.");
        return;
      }
      loadAnalysis([chess.fen()], [], "Imported position");
      setAnalysisError("");
      return;
    }

    const parsed = new Chess();
    try {
      parsed.loadPgn(text);
    } catch {
      setAnalysisError("That PGN could not be parsed.");
      return;
    }
    const moves = parsed.history();
    if (!moves.length) {
      setAnalysisError("That PGN contains no moves.");
      return;
    }
    const { fens } = replayMoves(moves);
    loadAnalysis(fens, moves, "Imported PGN");
    setAnalysisError("");
  }, [analysisInput, loadAnalysis, replayMoves]);

  const analysisFen = analysisFens[analysisPly] || START_FEN;

  useEffect(() => {
    if (section !== "analysis") return;
    let cancelled = false;
    let timer = null;
    setAnalysisEval({ loading: true });
    setAnalysisError("");
    timer = setTimeout(() => {
      stockfishRequest(analysisFen, analysisDepth)
        .then((data) => {
          if (cancelled) return;
          if (!data?.success) throw new Error("Stockfish could not analyse this position.");
          setAnalysisEval({ ...data, best: parseBestMove(data.bestmove) });
        })
        .catch((err) => {
          if (!cancelled) setAnalysisError(err.message || "Stockfish unavailable.");
        })
        .finally(() => {
          if (!cancelled) setAnalysisEval(prev => (prev ? { ...prev, loading: false } : prev));
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [section, analysisFen, analysisDepth]);

  // ─── Local (vs Computer) engine helpers ─────────────────────────────────────
  const persistComputerGame = useCallback(async (chess, winner, reason) => {
    if (!token || localGameSavedRef.current) return;
    localGameSavedRef.current = true;
    const result = winner === "w" ? "1-0" : winner === "b" ? "0-1" : "1/2-1/2";
    try {
      const res = await fetch(`${API_URL}/games`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          result,
          termination: reason,
          timeControl: localUnlimited ? "unlimited" : String(localTC),
          moves: chess.history(),
          playerColor: myColor,
          opponentName,
        }),
      });
      if (res.ok) fetchHistory();
    } catch {
      // History persistence must never interrupt the game.
    }
  }, [token, localUnlimited, localTC, myColor, opponentName, fetchHistory]);

  const finishLocalGame = useCallback((chessInstance, forced = {}) => {
    if (gameMode !== "computer") return;
    const chess = chessInstance || chessRef.current;
    let reason = forced.reason;
    let winner = forced.winner;

    if (!reason) {
      if (chess.isCheckmate()) {
        reason = "checkmate";
        winner = chess.turn() === "w" ? "b" : "w";
      } else if (chess.isStalemate()) {
        reason = "stalemate";
      } else if (chess.isThreefoldRepetition()) {
        reason = "threefold repetition";
      } else if (chess.isInsufficientMaterial()) {
        reason = "insufficient material";
      } else if (chess.isDraw()) {
        reason = "draw";
      } else {
        return;
      }
    }

    clockSyncRef.current = { ...clockSyncRef.current, running: false };
    computerThinkingRef.current = false;
    const winnerName = winner
      ? winner === myColor
        ? authUser?.username || myName || "You"
        : opponentName
      : null;

    setComputerThinking(false);
    setGameOver({ reason, winner, winnerName });
    setPremove(null);
    setPremoveSq(null);
    setSelectedSq(null);
    setOptionSquares({});
    setPhase("ended");
    persistComputerGame(chess, winner, reason);
  }, [gameMode, myColor, authUser, myName, opponentName, persistComputerGame]);

  const playLocalMove = useCallback((move) => {
    const chess = chessRef.current;
    let result;
    try { result = chess.move(move); } catch { result = null; }
    if (!result) return null;

    setFen(chess.fen());
    setTurn(chess.turn());
    setHistory(chess.history());
    setLastMove({ from: result.from, to: result.to });
    setSelectedSq(null);
    setOptionSquares({});
    setPositionAnalysis(null);
    if (localUnlimited) {
      clockSyncRef.current = { clocks: { w: 0, b: 0 }, turn: chess.turn(), ts: Date.now(), running: false };
      setDisplayClocks({ w: 0, b: 0 });
    } else {
      flipClockOnMove(chess.turn());
    }

    if (chess.isGameOver()) finishLocalGame(chess);
    return result;
  }, [flipClockOnMove, finishLocalGame, localUnlimited]);

  const analyseCurrentPosition = useCallback(async () => {
    const posFen = chessRef.current.fen();
    setPositionAnalysis({ loading: true });
    try {
      const data = await stockfishRequest(posFen, 12);
      if (!data?.success) throw new Error("Stockfish could not analyse this position.");
      setPositionAnalysis({ ...data, best: parseBestMove(data.bestmove) });
    } catch (err) {
      setPositionAnalysis({ error: err.message || "Stockfish unavailable." });
    }
  }, []);

  useEffect(() => {
    if (phase !== "game" || gameMode !== "computer") return;
    if (turn === myColor || computerThinkingRef.current) return;
    const chess = chessRef.current;
    if (chess.isGameOver()) return;

    let cancelled = false;
    computerThinkingRef.current = true;
    setComputerThinking(true);
    setComputerError("");
    const fenNow = chess.fen();

    const timer = setTimeout(() => {
      stockfishRequest(fenNow, computerDepth)
        .then((data) => {
          if (cancelled) return;
          if (!data?.success) throw new Error("Stockfish unavailable.");
          const best = parseBestMove(data.bestmove);
          let played = best
            ? playLocalMove({ from: best.from, to: best.to, promotion: best.promotion })
            : null;

          // Fail-safe: never leave a local game frozen because of the free API.
          if (!played) {
            const legal = chess.moves({ verbose: true });
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              played = playLocalMove({ from: m.from, to: m.to, promotion: m.promotion });
            }
          }
          if (played) {
            setComputerEval({
              evaluation: data.evaluation,
              mate: data.mate,
              best,
              continuation: data.continuation,
            });
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setComputerError(err.message || "Stockfish unavailable — played a fallback move.");
          const legal = chess.moves({ verbose: true });
          if (legal.length) {
            const m = legal[Math.floor(Math.random() * legal.length)];
            playLocalMove({ from: m.from, to: m.to, promotion: m.promotion });
          }
        })
        .finally(() => {
          if (!cancelled) {
            computerThinkingRef.current = false;
            setComputerThinking(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      computerThinkingRef.current = false;
      setComputerThinking(false);
    };
  }, [phase, gameMode, turn, myColor, computerDepth, playLocalMove]);

  // Local clock timeout detection (online timeouts are handled by the server).
  useEffect(() => {
    if (phase !== "game" || gameMode !== "computer" || localUnlimited) return;
    if (!clockSyncRef.current.running) return;
    if (displayClocks.w <= 0 || displayClocks.b <= 0) {
      const loser = displayClocks.w <= 0 ? "w" : "b";
      finishLocalGame(chessRef.current, {
        reason: "timeout",
        winner: loser === "w" ? "b" : "w",
      });
    }
  }, [displayClocks, phase, gameMode, localUnlimited, finishLocalGame]);

  // ─── Local ticking loop — runs continuously while a game is in progress, decrementing
  // only the side whose turn it is, and resyncing against the server snapshot on
  // every tick so client-side ticking can never drift far from server truth.
  useEffect(() => {
    const interval = setInterval(() => {
      const sync = clockSyncRef.current;
      if (!sync.running) return;
      const elapsed = Date.now() - sync.ts;
      const active = sync.turn;
      setDisplayClocks(prev => {
        const next = { ...sync.clocks };
        next[active] = Math.max(0, sync.clocks[active] - elapsed);
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // ─── Socket ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      auth: { token },
    });
    socketRef.current = socket;

    socket.on("assignedName", ({ name }) => setMyName(name));
    socket.on("waitingForOpponent", () => setPhase("waiting"));
    socket.on("queueCancelled",     () => setPhase("lobby"));

    socket.on("privateRoomCreated", (data) => {
      setPrivateRoom(data);
      setRoomError("");
      setCopied(false);
      setPhase("privateWaiting");
    });

    socket.on("privateRoomCancelled", () => {
      setPrivateRoom(null);
      setCopied(false);
      setPhase("lobby");
    });

    socket.on("roomError", ({ message }) => {
      setRoomError(message);
      setPhase(prev => (prev === "joiningRoom" ? "joinRoom" : prev));
    });

    socket.on("connect_error", (err) => {
      if (/token/i.test(err?.message || "")) {
        localStorage.removeItem("bb_token");
        setToken(null);
        setAuthUser(null);
        setMyName("");
        setAuthError("Session expired. Please log in again.");
      }
    });

    socket.on("gameStart", (data) => {
      chessRef.current = new Chess();
      setGameMode("online");
      setSection("play");
      localGameSavedRef.current = false;
      setRoomId(data.roomId);
      setMyColor(data.color);
      setOpponentName(data.opponentName);
      if (data.myName) setMyName(data.myName);
      setFen(data.fen);
      setTurn(data.turn || "w");
      syncClocks(data.clocks, data.turn || "w", true);
      setHistory([]);
      setLastMove(null);
      setGameOver(null);
      setDrawOffered(false);
      setSelectedSq(null);
      setOptionSquares({});
      setPremove(null);
      setPremoveSq(null);
      setChatMessages([]);
      setComputerEval(null);
      setComputerError("");
      setPositionAnalysis(null);
      setStatus(`${data.timeControl}m · ${data.color === "w" ? "You play White" : "You play Black"}`);
      // Consume the private room invite so a refresh doesn't re-open the join screen.
      setPrivateRoom(null);
      setJoinCode("");
      setRoomError("");
      setCopied(false);
      if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
      setPhase("game");
    });

    socket.on("moveUpdate", (data) => {
      // data: { fen, turn, move, clocks, san, history }
      // Always reconcile with authoritative server FEN
      chessRef.current.load(data.fen);
      setFen(data.fen);
      setTurn(data.turn);
      syncClocks(data.clocks, data.turn, true);
      rollbackFenRef.current = null; // server confirmed — clear rollback snapshot

      // *** Use server-sent history array if present, else append san locally ***
      if (Array.isArray(data.history)) {
        setHistory(data.history);
      } else if (data.san) {
        setHistory(prev => [...prev, data.san]);
      }

      if (data.move) setLastMove({ from: data.move.from, to: data.move.to });
      setSelectedSq(null);
      setOptionSquares({});
      setPositionAnalysis(null);

      // ── Fire queued premove if it's now our turn ──────────────────────────
      // We use a ref trick: read premove from a ref so the closure is fresh
    });

    socket.on("clockUpdate", ({ clocks, turn }) =>
      syncClocks(clocks, turn || clockSyncRef.current.turn, true)
    );

    socket.on("moveRejected", ({ reason }) => {
      setStatus(`⚠ ${reason}`);
      // Roll back optimistic update
      if (rollbackFenRef.current) {
        chessRef.current.load(rollbackFenRef.current);
        setFen(rollbackFenRef.current);
        rollbackFenRef.current = null;
      }
      setPremove(null);
      setPremoveSq(null);
      setSelectedSq(null);
      setOptionSquares({});
      // Shake the board
      setShake(true);
      setTimeout(() => setShake(false), 500);
    });

    socket.on("gameOver", ({ reason, winner, winnerName, clocks }) => {
      if (clocks) syncClocks(clocks, clockSyncRef.current.turn, false);
      else clockSyncRef.current.running = false;
      setGameOver({ reason, winner, winnerName });
      setPremove(null);
      setPremoveSq(null);
      setPhase("ended");
      setTimeout(() => fetchHistory(), 1400);
    });

    socket.on("chatMessage", ({ from, text }) => {
      setChatMessages(prev => [...prev, { from, text }]);
    });

    socket.on("drawOffered",  () => setDrawOffered(true));
    socket.on("drawDeclined", () => setStatus("Draw declined."));

    return () => socket.disconnect();
  }, [token, syncClocks, fetchHistory]);

  // ─── Premove fire effect ─────────────────────────────────────────────────────
  // When turn changes to myColor and there's a queued premove, fire it
  const premoveRef = useRef(null);
  const roomIdRef  = useRef(null);
  const myColorRef = useRef("w");

  useEffect(() => { premoveRef.current = premove; },   [premove]);
  useEffect(() => { roomIdRef.current  = roomId;  },   [roomId]);
  useEffect(() => { myColorRef.current = myColor; },   [myColor]);

  useEffect(() => {
    if (gameMode !== "online") return;
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
  }, [turn, gameMode]); // intentionally only re-runs when turn/game mode changes

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

  // ─── Optimistic move helper ─────────────────────────────────────────────────
  const sendMove = useCallback((move) => {
    const chess = chessRef.current;

    // Local games never touch the network; apply directly so move history is kept.
    if (gameMode === "computer") {
      const played = playLocalMove(move);
      if (played) {
        setComputerEval(null);
        setComputerError("");
      }
      return;
    }

    // Save current FEN for rollback
    rollbackFenRef.current = chess.fen();
    // Apply locally (chess.js clone so we don't mutate the ref yet)
    const preview = new Chess(chess.fen());
    let result;
    try { result = preview.move(move); } catch { result = null; }
    if (!result) {
      rollbackFenRef.current = null;
      return;
    }
    // Optimistically update board + history
    chessRef.current.load(preview.fen());
    setFen(preview.fen());
    setTurn(preview.turn());
    // Optimistically flip whose clock is ticking too, so the UI reflects the
    // move immediately instead of waiting for the server's moveUpdate/clockUpdate.
    // (This correctly bakes in the time spent on the move before flipping — see
    // flipClockOnMove above.)
    flipClockOnMove(preview.turn());
    setLastMove({ from: result.from, to: result.to });
    setHistory(preview.history());
    setSelectedSq(null);
    setOptionSquares({});
    setPositionAnalysis(null);
    // Send to server for authoritative validation
    socketRef.current?.emit("makeMove", { roomId, move });
  }, [roomId, flipClockOnMove, gameMode, playLocalMove]);

  // ─── Square click handler ────────────────────────────────────────────────────
  const onSquareClick = useCallback((square) => {
    if (phase !== "game") return;
    // Premoves are an online-only feature; local computer games simply wait.
    if (gameMode === "computer" && turn !== myColor) return;
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
            sendMove({ from: selectedSq, to: square });
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
  }, [phase, turn, myColor, selectedSq, premoveSq, roomId, getMoveOptions, sendMove, gameMode]);

  // ─── Drag-and-drop ──────────────────────────────────────────────────────────
  const onPieceDrop = useCallback((from, to, piece) => {
    const chess = chessRef.current;
    const isMyTurnNow = turn === myColor;

    if (gameMode === "computer" && !isMyTurnNow) return false;

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
      sendMove({ from, to });
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
  }, [turn, myColor, roomId, sendMove, gameMode]);

  // ─── Cancel premove ──────────────────────────────────────────────────────────
  const cancelPremove = () => { setPremove(null); setPremoveSq(null); };

  // ─── Confirm promotion piece ─────────────────────────────────────────────────
  const confirmPromotion = (piece) => {
    if (!pendingPromo) return;
    if (pendingPromo.isPremove) {
      // Queue as premove with chosen piece
      setPremove({ from: pendingPromo.from, to: pendingPromo.to, promotion: piece });
    } else {
      // Fire immediately with optimistic update
      sendMove({ from: pendingPromo.from, to: pendingPromo.to, promotion: piece });
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
  const findGame = () => {
    if (phase === "game" && gameMode === "online") {
      setSection("play");
      return;
    }
    if (phase === "game" && gameMode === "computer" && !window.confirm("Abandon this computer game?")) {
      return;
    }
    setGameMode("online");
    setSection("play");
    socketRef.current?.emit("findGame", { timeControl: selectedTC });
    setPhase("waiting");
  };
  const cancelQ    = () => socketRef.current?.emit("cancelQueue");
  const resign     = () => {
    if (!window.confirm("Resign?")) return;
    if (gameMode === "computer") {
      finishLocalGame(chessRef.current, {
        reason: "resignation",
        winner: myColor === "w" ? "b" : "w",
      });
      return;
    }
    socketRef.current?.emit("resign", { roomId });
  };
  const offerDraw  = () => { socketRef.current?.emit("offerDraw", { roomId }); setStatus("Draw offered…"); };
  const acceptDraw = () => { socketRef.current?.emit("acceptDraw", { roomId }); setDrawOffered(false); };
  const declineDraw= () => { socketRef.current?.emit("declineDraw", { roomId }); setDrawOffered(false); };

  const startComputerGame = () => {
    if (phase === "game" && gameMode === "online") {
      setStatus("Finish your online game first.");
      setSection("play");
      return;
    }

    const colorChoice = computerColor === "random"
      ? (Math.random() < 0.5 ? "w" : "b")
      : computerColor === "white" ? "w" : "b";
    const unlimited = computerTC === "unlimited";
    const tc = unlimited ? 0 : Number(computerTC);
    const ms = unlimited ? 0 : tc * 60 * 1000;

    chessRef.current = new Chess();
    localGameSavedRef.current = false;
    computerThinkingRef.current = false;
    setGameMode("computer");
    setSection("computer");
    setPhase("game");
    setRoomId(null);
    setMyColor(colorChoice);
    setMyName(authUser?.username || myName || "You");
    setOpponentName(`Stockfish (depth ${computerDepth})`);
    setFen(START_FEN);
    setTurn("w");
    setHistory([]);
    setLastMove(null);
    setGameOver(null);
    setDrawOffered(false);
    setSelectedSq(null);
    setOptionSquares({});
    setPremove(null);
    setPremoveSq(null);
    setPendingPromo(null);
    setChatMessages([]);
    setComputerEval(null);
    setComputerError("");
    setComputerThinking(false);
    setPositionAnalysis(null);
    setLocalUnlimited(unlimited);
    setLocalTC(unlimited ? 10 : tc);
    syncClocks({ w: ms, b: ms }, "w", !unlimited);
    setStatus(
      `${unlimited ? "Unlimited" : `${tc} min`} · vs Stockfish · depth ${computerDepth}`
    );
  };

  const playAgain  = () => {
    if (gameMode === "computer") {
      setPhase("lobby");
      setSection("computer");
      setGameOver(null);
      setFen(START_FEN);
      setTurn("w");
      setHistory([]);
      setLastMove(null);
      setComputerEval(null);
      setComputerError("");
      setComputerThinking(false);
      computerThinkingRef.current = false;
      setPositionAnalysis(null);
      chessRef.current = new Chess();
      syncClocks({ w: 0, b: 0 }, "w", false);
      return;
    }

    setSection("play");
    setPhase("lobby"); setGameOver(null); setFen("start"); chessRef.current = new Chess();
    setHistory([]); setLastMove(null); setPositionAnalysis(null);
    clockSyncRef.current = { clocks: { w: 300000, b: 300000 }, turn: "w", ts: Date.now(), running: false };
    setDisplayClocks({ w: 300000, b: 300000 });
  };

  // ─── Auth actions ────────────────────────────────────────────────────────────
  const submitAuth = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    setAuthError("");

    const username = authUsername.trim();
    if (authTab !== "guest") {
      if (!username || !authPassword) {
        setAuthError("Enter a username and password");
        return;
      }
      if (authTab === "register" && username.length < 3) {
        setAuthError("Username must be at least 3 characters");
        return;
      }
      if (authTab === "register" && authPassword !== authConfirm) {
        setAuthError("Passwords do not match");
        return;
      }
    }

    setAuthBusy(true);
    try {
      const endpoint = authTab === "guest" ? "guest" : authTab;
      const res = await fetch(`${API_URL}/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: authTab === "guest"
          ? undefined
          : JSON.stringify({ username, password: authPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || "Authentication failed");

      // Always decode identity from the JWT — never trust a separate user payload.
      const decoded = jwtDecode(data.token);
      localStorage.setItem("bb_token", data.token);
      setToken(data.token);
      setAuthUser({ username: decoded.username, isGuest: !!decoded.isGuest, userId: decoded.userId });
      setMyName(decoded.username || "");
      setAuthUsername("");
      setAuthPassword("");
      setAuthConfirm("");
    } catch (err) {
      setAuthError(err.message || "Authentication failed");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = () => {
    socketRef.current?.disconnect();
    localStorage.removeItem("bb_token");
    setToken(null);
    setAuthUser(null);
    setMyName("");
    setPhase("lobby");
    setSection("home");
    setGameMode("online");
    setJoinCode("");
    setPrivateRoom(null);
    setRoomError("");
    setCopied(false);
    setGameOver(null);
    setChatMessages([]);
    setStatus("");
    if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
  };

  // ─── Private room actions ────────────────────────────────────────────────────
  const shareUrl = privateRoom
    ? `${window.location.origin}${window.location.pathname}?room=${privateRoom.code}`
    : "";

  const createPrivate = () => {
    setRoomError("");
    setGameMode("online");
    setSection("friends");
    socketRef.current?.emit("createPrivateRoom", { timeControl: selectedTC });
  };

  const joinPrivate = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setRoomError("Enter a room code");
      return;
    }
    setJoinCode(code);
    setRoomError("");
    setGameMode("online");
    setSection("friends");
    setPhase("joiningRoom");
    socketRef.current?.emit("joinPrivateRoom", { code });
  };

  const cancelPrivate = () => {
    if (privateRoom) {
      socketRef.current?.emit("cancelPrivateRoom", { code: privateRoom.code });
    }
    setPrivateRoom(null);
    setCopied(false);
    setPhase("lobby");
  };

  const leaveJoinScreen = () => {
    setJoinCode("");
    setRoomError("");
    setPhase("lobby");
    if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
  };

  const copyShareLink = async () => {
    if (!shareUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const el = document.createElement("textarea");
      el.value = shareUrl;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Square styles ───────────────────────────────────────────────────────────
  const chess   = chessRef.current;
  const oppColor= myColor === "w" ? "b" : "w";
  const isMyTurn= phase === "game" && turn === myColor;
  const inCheck = phase === "game" && chess.inCheck();
  const kingPos = inCheck ? kingSquare(chess, turn) : null;
  const myMs    = displayClocks[myColor] ?? 0;
  const oppMs   = displayClocks[oppColor] ?? 0;

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
  if (positionAnalysis?.best) {
    sqStyles[positionAnalysis.best.from] = {
      ...sqStyles[positionAnalysis.best.from],
      boxShadow: "inset 0 0 0 3px rgba(74,222,128,0.95)",
      backgroundColor: "rgba(74,222,128,0.28)",
    };
    sqStyles[positionAnalysis.best.to] = {
      ...sqStyles[positionAnalysis.best.to],
      boxShadow: "inset 0 0 0 3px rgba(74,222,128,0.95)",
      backgroundColor: "rgba(74,222,128,0.5)",
    };
  }

  const analysisSqStyles = {};
  if (analysisEval?.best) {
    analysisSqStyles[analysisEval.best.from] = {
      backgroundColor: "rgba(74,222,128,0.3)",
      boxShadow: "inset 0 0 0 3px rgba(74,222,128,0.95)",
    };
    analysisSqStyles[analysisEval.best.to] = {
      backgroundColor: "rgba(74,222,128,0.55)",
      boxShadow: "inset 0 0 0 3px rgba(74,222,128,0.95)",
    };
  }

  const gameVisible = (phase === "game" || phase === "ended") &&
    ((gameMode === "online" && section === "play") ||
     (gameMode === "computer" && section === "computer"));
  const hiddenActiveGame = phase === "game" &&
    ((gameMode === "online" && section !== "play") ||
     (gameMode === "computer" && section !== "computer"));

  const recentStats = gameHistory.reduce((acc, game) => {
    const r = gameUserResult(game, authUser);
    acc.total += 1;
    if (r === "W") acc.wins += 1;
    else if (r === "L") acc.losses += 1;
    else if (r === "D") acc.draws += 1;
    return acc;
  }, { total: 0, wins: 0, losses: 0, draws: 0 });

  const analysisContinuation = analysisEval?.success
    ? uciToSanLine(analysisFen, analysisEval.continuation)
    : "";
  const positionContinuation = positionAnalysis?.success
    ? uciToSanLine(fen, positionAnalysis.continuation)
    : "";

  // ─── Render ──────────────────────────────────────────────────────────────────
  const clockUnlimited = gameMode === "computer" && localUnlimited;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d0d0f; }
        button { -webkit-tap-highlight-color: transparent; }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes blink   { 0%,100%{ opacity:1; } 50%{ opacity:0.25; } }
        @keyframes checkGlow {
          0%,100% { box-shadow: 0 0 0 2px rgba(220,50,50,0.4), 0 20px 60px rgba(0,0,0,0.8); }
          50%     { box-shadow: 0 0 20px 4px rgba(220,50,50,0.7), 0 20px 60px rgba(0,0,0,0.8); }
        }
        @keyframes rejectShake {
          0%,100% { transform: translateX(0); }
          15%     { transform: translateX(-8px); }
          30%     { transform: translateX(7px); }
          45%     { transform: translateX(-5px); }
          60%     { transform: translateX(4px); }
          75%     { transform: translateX(-2px); }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2e2820; border-radius: 2px; }
      `}</style>

      <div style={{
        minHeight: "100vh", background: "#0d0d0f", color: "#e8e0d0",
        fontFamily: "'IM Fell English', Georgia, serif", fontSize: 16,
        display: "flex", flexDirection: "column", alignItems: "stretch",
        padding: isMobile ? "10px 10px 32px" : "14px 16px 44px",
      }}>

        {!token ? (
          /* ── AUTH ─────────────────────────────────────────────────────────── */
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            width: "100%", padding: "24px 0" }}>
            <div style={{ width:"100%", maxWidth:390, background:"#1a1714",
              border:"1px solid #2e2820", borderRadius:12, padding:"30px 26px",
              display:"flex", flexDirection:"column", gap:18,
              boxShadow:"0 20px 60px rgba(0,0,0,0.5)" }}>

              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:38, color:"#c8a96e", lineHeight:1, marginBottom:8 }}>♟</div>
                <h1 style={{ fontSize:36, fontWeight:400, color:"#e8e0d0", lineHeight:1.1 }}>BlitzBoard</h1>
                <p style={{ fontSize:12, color:"#4a4035", letterSpacing:3, textTransform:"uppercase", marginTop:8 }}>
                  Play. Analyse. Improve.
                </p>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                {[
                  { id:"login", label:"Login" },
                  { id:"register", label:"Register" },
                  { id:"guest", label:"Guest" },
                ].map(t => (
                  <button key={t.id} type="button"
                    onClick={() => { setAuthTab(t.id); setAuthError(""); }}
                    style={{
                      padding:"10px 4px", borderRadius:6, cursor:"pointer",
                      fontFamily:"inherit", fontSize:13, letterSpacing:2,
                      textTransform:"uppercase", transition:"all 0.15s",
                      background: authTab===t.id ? "rgba(200,169,110,0.12)" : "transparent",
                      border: `1px solid ${authTab===t.id ? "#c8a96e" : "#2e2820"}`,
                      color: authTab===t.id ? "#c8a96e" : "#6b5f4b",
                    }}>{t.label}</button>
                ))}
              </div>

              <form onSubmit={submitAuth} style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {authTab !== "guest" && (
                  <>
                    <input
                      value={authUsername}
                      onChange={e => setAuthUsername(e.target.value)}
                      placeholder="Username"
                      autoComplete="username"
                      maxLength={20}
                      style={authInputStyle}
                      onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                      onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                    />
                    <input
                      type="password"
                      value={authPassword}
                      onChange={e => setAuthPassword(e.target.value)}
                      placeholder="Password"
                      autoComplete={authTab === "register" ? "new-password" : "current-password"}
                      style={authInputStyle}
                      onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                      onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                    />
                  </>
                )}

                {authTab === "register" && (
                  <input
                    type="password"
                    value={authConfirm}
                    onChange={e => setAuthConfirm(e.target.value)}
                    placeholder="Confirm password"
                    autoComplete="new-password"
                    style={authInputStyle}
                    onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                    onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                  />
                )}

                {authTab === "guest" && (
                  <p style={{ fontSize:15, color:"#6b5f4b", textAlign:"center", lineHeight:1.5 }}>
                    Jump straight in with a temporary name. No password needed.
                  </p>
                )}

                {authError && (
                  <p style={{ fontSize:14, color:"#e05252", textAlign:"center" }}>{authError}</p>
                )}

                <button type="submit" disabled={authBusy} style={{
                  width:"100%", padding:15, marginTop:2,
                  background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                  border:"none", borderRadius:6, color:"#0d0d0f",
                  fontSize:14, letterSpacing:3, textTransform:"uppercase",
                  fontFamily:"inherit", cursor: authBusy ? "wait" : "pointer",
                  opacity: authBusy ? 0.7 : 1,
                }}>
                  {authBusy
                    ? "Please wait…"
                    : authTab === "guest"
                    ? "Play as Guest"
                    : authTab === "register"
                    ? "Create Account"
                    : "Login"}
                </button>
              </form>
            </div>
          </div>
        ) : (
          <>
            <NavBar section={section} onNavigate={setSection} user={authUser}
              onLogout={logout} isMobile={isMobile} />

            <main style={{ width:"100%", maxWidth:1100, margin:"0 auto", padding: isMobile ? "20px 2px 30px" : "28px 4px 40px" }}>
              {hiddenActiveGame && (
                <div style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
                  background:"rgba(200,169,110,0.08)", border:"1px solid #3a3228",
                  borderRadius:7, padding:"12px 14px", marginBottom:18, flexWrap:"wrap",
                }}>
                  <span style={{ fontSize:15, color:"#b8a98a" }}>
                    A game is still in progress.
                  </span>
                  <button onClick={() => setSection(gameMode === "computer" ? "computer" : "play")}
                    style={{ ...gBtn(), borderColor:"#c8a96e", color:"#c8a96e" }}>
                    Return to game
                  </button>
                </div>
              )}

              {gameVisible ? (
                /* ── GAME ─────────────────────────────────────────────────────── */
                <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row",
                  gap:16, alignItems:"flex-start", width:"100%", maxWidth:920, margin:"0 auto" }}>

                  <div style={{ display:"flex", flexDirection:"column", gap:8, flexShrink:0,
                    width: isMobile ? "100%" : "min(520px, 100%)", maxWidth:560 }}>

                    <PlayerRow name={opponentName} isMe={false}
                      active={turn===oppColor && phase==="game"} ms={oppMs} low={oppMs<10000}
                      unlimited={clockUnlimited} />

                    <div style={{
                      borderRadius:4, overflow:"hidden",
                      boxShadow: inCheck && turn===myColor
                        ? "0 0 0 3px rgba(220,50,50,0.7), 0 20px 60px rgba(0,0,0,0.8)"
                        : "0 20px 60px rgba(0,0,0,0.8), 0 0 0 1px #2e2820",
                      animation: shake ? "rejectShake 0.45s ease"
                        : inCheck && turn===myColor ? "checkGlow 1.5s ease-in-out infinite" : "none",
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
                      active={isMyTurn} ms={myMs} low={myMs<10000}
                      unlimited={clockUnlimited} />

                    <div style={{ minHeight:26, display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"0 2px", gap:8 }}>
                      <span style={{
                        fontSize:13, letterSpacing:2,
                        color: (inCheck && turn===myColor) || computerError ? "#e05252"
                          : gameMode==="computer" && computerThinking ? "#c8a96e" : "#6b5f4b",
                        textTransform:"uppercase",
                      }}>
                        {gameMode==="computer" && computerThinking ? "stockfish thinking…"
                          : gameMode==="computer" && computerError ? "engine issue — fallback used"
                          : inCheck && turn===myColor ? "⚠ check"
                          : gameMode==="online" && premove ? `⟳ premove: ${premove.from}→${premove.to}`
                          : gameMode==="online" && premoveSq ? "select destination…"
                          : isMyTurn ? "your move"
                          : gameMode==="computer" ? "stockfish to move…" : "waiting…"}
                      </span>
                      {gameMode==="online" && (premove || premoveSq) && (
                        <button onClick={cancelPremove} style={{ background:"transparent",
                          border:"1px solid #3a3060", color:"#8080cc", fontSize:13, letterSpacing:1,
                          padding:"3px 8px", borderRadius:4, cursor:"pointer", fontFamily:"inherit",
                          textTransform:"uppercase" }}>cancel premove</button>
                      )}
                    </div>

                    {drawOffered && gameMode === "online" && (
                      <div style={{ display:"flex", alignItems:"center", gap:10,
                        background:"#1e1a16", border:"1px solid #3a3228", borderRadius:7,
                        padding:"10px 14px", fontSize:15, color:"#b8a98a" }}>
                        <span style={{ flex:1 }}>Opponent offers a draw</span>
                        <button onClick={acceptDraw}  style={gBtn()}>Accept</button>
                        <button onClick={declineDraw} style={gBtn("danger")}>Decline</button>
                      </div>
                    )}

                    {phase === "game" && (
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                        {gameMode === "online" && (
                          <button onClick={offerDraw} style={gBtn()}>Offer Draw</button>
                        )}
                        <button onClick={resign} style={gBtn("danger")}>Resign</button>
                        {gameMode === "computer" && (
                          <button onClick={() => {
                            if (window.confirm("Restart against the computer?")) startComputerGame();
                          }} style={gBtn()}>Restart vs Computer</button>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ flex:1, display:"flex", flexDirection:"column", gap:10,
                    minWidth:0, width: isMobile ? "100%" : "auto", alignSelf:"stretch", minHeight:0 }}>
                    <MoveHistory history={history} />

                    <div style={{ background:"#0f0e0c", border:"1px solid #1e1a16", borderRadius:7,
                      padding:12, display:"flex", flexDirection:"column", gap:8 }}>
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                        <span style={{ fontSize:12, letterSpacing:2, color:"#4a4035",
                          textTransform:"uppercase" }}>Position analysis</span>
                        <button onClick={analyseCurrentPosition} disabled={positionAnalysis?.loading}
                          style={{ ...gBtn(), padding:"6px 10px", fontSize:14,
                            opacity: positionAnalysis?.loading ? 0.65 : 1 }}>
                          {positionAnalysis?.loading ? "Analysing…" : "Analyse Position"}
                        </button>
                      </div>

                      {positionAnalysis?.loading && (
                        <span style={{ fontSize:14, color:"#8a7a62" }}>Asking Stockfish…</span>
                      )}
                      {positionAnalysis?.error && (
                        <span style={{ fontSize:14, color:"#e05252" }}>{positionAnalysis.error}</span>
                      )}
                      {positionAnalysis?.success && (
                        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                          <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
                            <span style={{ fontFamily:"'Courier New', monospace", fontSize:24,
                              color:"#c8a96e" }}>{formatEval(positionAnalysis.evaluation, positionAnalysis.mate)}</span>
                            {positionAnalysis.best && (
                              <span style={{ fontFamily:"'Courier New', monospace", fontSize:14,
                                color:"#8a7a62" }}>best {positionAnalysis.best.uci}</span>
                            )}
                          </div>
                          {positionContinuation && (
                            <span style={{ fontFamily:"'Courier New', monospace", fontSize:14,
                              color:"#9a8a72", lineHeight:1.5 }}>
                              {positionContinuation}
                            </span>
                          )}
                        </div>
                      )}
                      {!positionAnalysis && (
                        <span style={{ fontSize:14, color:"#4a4035", fontStyle:"italic" }}>
                          Get an evaluation and best move without leaving the game.
                        </span>
                      )}

                      {gameMode === "computer" && computerEval && (
                        <div style={{ borderTop:"1px solid #1a1612", paddingTop:7,
                          display:"flex", gap:10, flexWrap:"wrap", alignItems:"baseline" }}>
                          <span style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase",
                            color:"#4a4035" }}>Engine</span>
                          <span style={{ fontFamily:"'Courier New', monospace", fontSize:16,
                            color:"#b8a98a" }}>{formatEval(computerEval.evaluation, computerEval.mate)}</span>
                          {computerEval.best && (
                            <span style={{ fontFamily:"'Courier New', monospace", fontSize:14,
                              color:"#6b5f4b" }}>{computerEval.best.uci}</span>
                          )}
                        </div>
                      )}
                      {gameMode === "computer" && computerError && (
                        <span style={{ fontSize:14, color:"#e05252" }}>{computerError}</span>
                      )}
                    </div>

                    {gameMode === "online" && (
                      <Chat messages={chatMessages} onSend={sendChat} myName={myName} />
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* ── HOME ─────────────────────────────────────────────────── */}
                  {section === "home" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:30 }}>
                      <div style={{ textAlign:"center", padding: isMobile ? "12px 4px 2px" : "20px 10px 6px" }}>
                        <div style={{ fontSize: isMobile ? 74 : 100, color:"#c8a96e", lineHeight:0.9,
                          textShadow:"0 12px 40px rgba(200,169,110,0.16)" }}>♛</div>
                        <h1 style={{ fontSize: isMobile ? 36 : 52, fontWeight:400, marginTop:16,
                          lineHeight:1.08 }}>Play. Analyse. Improve.</h1>
                        <p style={{ fontSize:17, color:"#8a7a62", marginTop:12, maxWidth:620,
                          marginLeft:"auto", marginRight:"auto", lineHeight:1.6 }}>
                          Real-time online chess, a full Stockfish study board, and a computer
                          opponent that meets you at your level.
                        </p>
                        <button onClick={() => setSection("play")} style={{
                          marginTop:22, padding:"14px 28px",
                          background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                          border:"none", borderRadius:6, color:"#0d0d0f",
                          fontSize:14, letterSpacing:3, textTransform:"uppercase",
                          fontFamily:"inherit", cursor:"pointer",
                        }}>Play Online</button>
                      </div>

                      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap:12 }}>
                        {[
                          { id:"play", icon:"⚔", title:"Play Online", text:"Match with a real opponent at 1, 3, 5 or 10 minutes. Private rooms included." },
                          { id:"computer", icon:"♞", title:"vs Computer", text:"Four difficulty levels, any colour, and the clock of your choice." },
                          { id:"analysis", icon:"◎", title:"Analyse Games", text:"Import PGN or FEN, step through history, and study with Stockfish." },
                        ].map(card => (
                          <button key={card.id} onClick={() => setSection(card.id)} style={{
                            textAlign:"left", background:"#1a1714", border:"1px solid #2e2820",
                            borderRadius:8, padding:"20px 18px", color:"#e8e0d0",
                            fontFamily:"inherit", cursor:"pointer", display:"flex",
                            flexDirection:"column", gap:9,
                          }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = "#3a3228"}
                          onMouseLeave={e => e.currentTarget.style.borderColor = "#2e2820"}>
                            <span style={{ fontSize:30, color:"#c8a96e", lineHeight:1 }}>{card.icon}</span>
                            <span style={{ fontSize:22 }}>{card.title}</span>
                            <span style={{ fontSize:14, color:"#8a7a62", lineHeight:1.55 }}>{card.text}</span>
                          </button>
                        ))}
                      </div>

                      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap:10 }}>
                        {[
                          { label:"Recent games", value:recentStats.total },
                          { label:"Wins", value:recentStats.wins },
                          { label:"Losses", value:recentStats.losses },
                          { label:"Draws", value:recentStats.draws },
                        ].map(stat => (
                          <div key={stat.label} style={{
                            background:"#1a1714", border:"1px solid #2e2820", borderRadius:8,
                            padding:"14px 12px", textAlign:"center",
                          }}>
                            <div style={{ fontFamily:"'Courier New', monospace", fontSize:28, color:"#c8a96e" }}>{stat.value}</div>
                            <div style={{ fontSize:12, color:"#6b5f4b", letterSpacing:2,
                              textTransform:"uppercase", marginTop:5 }}>{stat.label}</div>
                          </div>
                        ))}
                      </div>

                      <div>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginBottom:12 }}>
                          <h2 style={{ fontSize:26, fontWeight:400 }}>Recent activity</h2>
                          <button onClick={() => setSection("history")} style={{ ...gBtn(), fontSize:14 }}>View all</button>
                        </div>
                        {historyLoading && gameHistory.length === 0 ? (
                          <p style={{ fontSize:15, color:"#6b5f4b" }}>Loading games…</p>
                        ) : gameHistory.length === 0 ? (
                          <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:8,
                            padding:"18px", fontSize:15, color:"#6b5f4b" }}>
                            No completed games yet. Your last 10 games will appear here.
                          </div>
                        ) : (
                          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                            {gameHistory.slice(0, 3).map(game => {
                              const r = gameUserResult(game, authUser);
                              const color = gameUserColor(game, authUser);
                              const opp = color === "w" ? game.black : color === "b" ? game.white : null;
                              return (
                                <button key={game._id} onClick={() => openGameAnalysis(game)} style={{
                                  display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
                                  width:"100%", textAlign:"left", background:"#1a1714",
                                  border:"1px solid #2e2820", borderRadius:7, padding:"11px 13px",
                                  color:"#e8e0d0", fontFamily:"inherit", cursor:"pointer",
                                }}>
                                  <ResultBadge result={r} />
                                  <span style={{ fontSize:16, flex:1, minWidth:110 }}>
                                    vs {opp?.username || "Opponent"}
                                  </span>
                                  <span style={{ fontSize:14, color:"#6b5f4b" }}>
                                    {game.timeControl === "unlimited" ? "Unlimited" : `${game.timeControl} min`}
                                    {" · "}{game.termination}
                                  </span>
                                  <span style={{ fontSize:14, color:"#4a4035" }}>{formatGameDate(game.playedAt)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── PLAY ONLINE ─────────────────────────────────────────── */}
                  {section === "play" && (
                    phase === "waiting" ? (
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:20,
                        color:"#b8a98a", padding:"70px 10px" }}>
                        <div style={{ width:40, height:40, border:"2px solid #2e2820",
                          borderTop:"2px solid #c8a96e", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
                        <p style={{ fontSize:17 }}>Seeking opponent for {selectedTC} min…</p>
                        <button onClick={cancelQ} style={{ ...gBtn(), padding:"10px 24px" }}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:24,
                        maxWidth:480, width:"100%", margin:"0 auto", paddingTop: isMobile ? 6 : 18 }}>
                        <div style={{ textAlign:"center" }}>
                          <h1 style={{ fontSize: isMobile ? 34 : 44, fontWeight:400, lineHeight:1.1 }}>Find a Game</h1>
                          <p style={{ fontSize:12, color:"#4a4035", letterSpacing:3,
                            textTransform:"uppercase", marginTop:9 }}>Real-time · Server validated</p>
                        </div>

                        {myName && (
                          <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:6,
                            padding:"10px 20px", fontSize:16, color:"#b8a98a", fontStyle:"italic" }}>
                            Playing as: {myName}
                          </div>
                        )}

                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, width:"100%" }}>
                          {[1,3,5,10].map(tc => (
                            <button key={tc} onClick={() => setSelectedTC(tc)} style={{
                              background: selectedTC===tc ? "#c8a96e" : "#1a1714",
                              border: `1px solid ${selectedTC===tc ? "#c8a96e" : "#2e2820"}`,
                              color: selectedTC===tc ? "#0d0d0f" : "#b8a98a",
                              borderRadius:6, padding:14, fontSize:20, fontFamily:"inherit",
                              cursor:"pointer", transition:"all 0.15s",
                              display:"flex", flexDirection:"column", alignItems:"center", gap:2,
                            }}>
                              {tc}
                              <span style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase" }}>min</span>
                            </button>
                          ))}
                        </div>

                        <button onClick={findGame} style={{
                          width:"100%", padding:16,
                          background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                          border:"none", borderRadius:6, color:"#0d0d0f",
                          fontSize:14, letterSpacing:3, textTransform:"uppercase",
                          fontFamily:"inherit", cursor:"pointer",
                        }}>Find Opponent</button>

                        <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:11 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:10, color:"#3a3228",
                            fontSize:12, letterSpacing:3, textTransform:"uppercase" }}>
                            <div style={{ flex:1, height:1, background:"#2e2820" }} />
                            Play with a Friend
                            <div style={{ flex:1, height:1, background:"#2e2820" }} />
                          </div>

                          <button onClick={createPrivate} style={{
                            width:"100%", padding:13, background:"transparent",
                            border:"1px solid #3a3228", borderRadius:6, color:"#b8a98a",
                            fontSize:14, letterSpacing:2, textTransform:"uppercase",
                            fontFamily:"inherit", cursor:"pointer",
                          }}>Create Private Room</button>

                          <div style={{ display:"flex", gap:7 }}>
                            <input
                              value={joinCode}
                              onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                              placeholder="ROOM CODE"
                              maxLength={6}
                              style={{ ...authInputStyle, flex:1, textAlign:"center",
                                fontFamily:"'Courier New', monospace", fontSize:16, letterSpacing:3 }}
                              onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                              onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                            />
                            <button onClick={joinPrivate} style={{ ...gBtn(), padding:"10px 16px" }}>Join</button>
                          </div>

                          {roomError && (
                            <p style={{ fontSize:14, color:"#e05252", textAlign:"center" }}>{roomError}</p>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {/* ── VS COMPUTER SETUP ───────────────────────────────────── */}
                  {section === "computer" && (
                    <div style={{ maxWidth:680, margin:"0 auto" }}>
                      <SectionHeader title="Play vs Computer" subtitle="Choose your terms" isMobile={isMobile} />

                      <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:10,
                        padding: isMobile ? 18 : 26, display:"flex", flexDirection:"column", gap:24 }}>

                        <div>
                          <div style={{ fontSize:12, letterSpacing:2, color:"#6b5f4b",
                            textTransform:"uppercase", marginBottom:9 }}>Difficulty</div>
                          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                            {[
                              { label:"Easy", depth:4 },
                              { label:"Medium", depth:8 },
                              { label:"Hard", depth:12 },
                              { label:"Expert", depth:15 },
                            ].map(opt => (
                              <button key={opt.depth} onClick={() => setComputerDepth(opt.depth)} style={{
                                padding:"13px 10px", borderRadius:6, cursor:"pointer", fontFamily:"inherit",
                                background: computerDepth===opt.depth ? "rgba(200,169,110,0.12)" : "transparent",
                                border: `1px solid ${computerDepth===opt.depth ? "#c8a96e" : "#2e2820"}`,
                                color: computerDepth===opt.depth ? "#c8a96e" : "#8a7a62",
                                display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                              }}>
                                <span style={{ fontSize:17 }}>{opt.label}</span>
                                <span style={{ fontSize:12, letterSpacing:1, color:"#6b5f4b" }}>depth {opt.depth}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div style={{ fontSize:12, letterSpacing:2, color:"#6b5f4b",
                            textTransform:"uppercase", marginBottom:9 }}>Your colour</div>
                          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                            {[
                              { id:"white", label:"White", icon:"♔" },
                              { id:"black", label:"Black", icon:"♚" },
                              { id:"random", label:"Random", icon:"⚄" },
                            ].map(opt => (
                              <button key={opt.id} onClick={() => setComputerColor(opt.id)} style={{
                                padding:"11px 6px", borderRadius:6, cursor:"pointer", fontFamily:"inherit",
                                background: computerColor===opt.id ? "rgba(200,169,110,0.12)" : "transparent",
                                border: `1px solid ${computerColor===opt.id ? "#c8a96e" : "#2e2820"}`,
                                color: computerColor===opt.id ? "#c8a96e" : "#8a7a62",
                                fontSize:16, display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                              }}>
                                <span style={{ fontSize:22, lineHeight:1 }}>{opt.icon}</span>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div style={{ fontSize:12, letterSpacing:2, color:"#6b5f4b",
                            textTransform:"uppercase", marginBottom:9 }}>Time control</div>
                          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap:7 }}>
                            {[
                              { id:"unlimited", label:"Unlimited" },
                              { id:"1", label:"1 min" },
                              { id:"3", label:"3 min" },
                              { id:"5", label:"5 min" },
                              { id:"10", label:"10 min" },
                            ].map(opt => (
                              <button key={opt.id} onClick={() => setComputerTC(opt.id)} style={{
                                padding:"11px 5px", borderRadius:6, cursor:"pointer", fontFamily:"inherit",
                                background: computerTC===opt.id ? "#c8a96e" : "transparent",
                                border: `1px solid ${computerTC===opt.id ? "#c8a96e" : "#2e2820"}`,
                                color: computerTC===opt.id ? "#0d0d0f" : "#8a7a62", fontSize:15,
                              }}>{opt.label}</button>
                            ))}
                          </div>
                        </div>

                        <button onClick={startComputerGame} style={{
                          padding:16, background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                          border:"none", borderRadius:6, color:"#0d0d0f",
                          fontSize:14, letterSpacing:3, textTransform:"uppercase",
                          fontFamily:"inherit", cursor:"pointer",
                        }}>Start Game</button>

                        <p style={{ fontSize:14, color:"#6b5f4b", lineHeight:1.55, textAlign:"center" }}>
                          Powered by Stockfish Online. Every engine move waits at least 300ms so the
                          board feels natural.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── ANALYSIS ────────────────────────────────────────────── */}
                  {section === "analysis" && (
                    <div>
                      <SectionHeader title="Analysis" subtitle="Study any position" isMobile={isMobile}>
                        <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                          {[
                            { label:"Fast", depth:8 },
                            { label:"Deep", depth:12 },
                            { label:"Max", depth:15 },
                          ].map(opt => (
                            <button key={opt.depth} onClick={() => setAnalysisDepth(opt.depth)} style={{
                              padding:"8px 11px", borderRadius:5, cursor:"pointer", fontFamily:"inherit",
                              background: analysisDepth===opt.depth ? "rgba(200,169,110,0.12)" : "transparent",
                              border: `1px solid ${analysisDepth===opt.depth ? "#c8a96e" : "#2e2820"}`,
                              color: analysisDepth===opt.depth ? "#c8a96e" : "#8a7a62", fontSize:14,
                            }}>{opt.label}</button>
                          ))}
                        </div>
                      </SectionHeader>

                      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                        {[
                          { id:"import", label:"Import" },
                          { id:"history", label:"From History" },
                        ].map(tab => (
                          <button key={tab.id} onClick={() => setAnalysisTab(tab.id)} style={{
                            padding:"9px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit",
                            background: analysisTab===tab.id ? "rgba(200,169,110,0.12)" : "transparent",
                            border: `1px solid ${analysisTab===tab.id ? "#c8a96e" : "#2e2820"}`,
                            color: analysisTab===tab.id ? "#c8a96e" : "#6b5f4b",
                            fontSize:14, letterSpacing:1, textTransform:"uppercase",
                          }}>{tab.label}</button>
                        ))}
                      </div>

                      {analysisTab === "import" ? (
                        <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:8,
                          padding:16, marginBottom:16, display:"flex", flexDirection:"column", gap:10 }}>
                          <textarea
                            value={analysisInput}
                            onChange={e => setAnalysisInput(e.target.value)}
                            placeholder="Paste a PGN game or a FEN position…"
                            style={{ ...authInputStyle, minHeight:120, resize:"vertical",
                              lineHeight:1.5, fontFamily:"'Courier New', monospace", fontSize:14 }}
                            onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                            onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                          />
                          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                            <button onClick={importAnalysis} style={{
                              padding:"10px 18px", background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                              border:"none", borderRadius:5, color:"#0d0d0f", cursor:"pointer",
                              fontFamily:"inherit", fontSize:14, letterSpacing:2, textTransform:"uppercase",
                            }}>Load Position</button>
                            <button onClick={() => { setAnalysisInput(""); setAnalysisError(""); }}
                              style={gBtn()}>Clear</button>
                            {analysisError && <span style={{ fontSize:14, color:"#e05252" }}>{analysisError}</span>}
                          </div>
                        </div>
                      ) : (
                        <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:8,
                          padding:14, marginBottom:16, display:"flex", flexDirection:"column", gap:7 }}>
                          {historyLoading && gameHistory.length === 0 ? (
                            <span style={{ fontSize:15, color:"#6b5f4b" }}>Loading games…</span>
                          ) : gameHistory.length === 0 ? (
                            <span style={{ fontSize:15, color:"#6b5f4b" }}>No saved games yet.</span>
                          ) : gameHistory.map(game => {
                            const r = gameUserResult(game, authUser);
                            return (
                              <button key={game._id} onClick={() => openGameAnalysis(game)} style={{
                                display:"flex", alignItems:"center", gap:9, flexWrap:"wrap",
                                width:"100%", textAlign:"left", background:"transparent",
                                border:"1px solid #2e2820", borderRadius:6, padding:"9px 10px",
                                color:"#e8e0d0", fontFamily:"inherit", cursor:"pointer",
                              }}>
                                <ResultBadge result={r} />
                                <span style={{ fontSize:15, flex:1, minWidth:120 }}>
                                  {game.white?.username || "White"} vs {game.black?.username || "Black"}
                                </span>
                                <span style={{ fontSize:14, color:"#6b5f4b" }}>{formatGameDate(game.playedAt)}</span>
                                <span style={{ fontSize:14, color:"#c8a96e" }}>Load</span>
                              </button>
                            );
                          })}
                          {historyError && <span style={{ fontSize:14, color:"#e05252" }}>{historyError}</span>}
                        </div>
                      )}

                      <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row",
                        gap:14, alignItems:"stretch" }}>
                        <div style={{ display:"flex", gap:10, flex: isMobile ? "none" : "0 0 auto",
                          width: isMobile ? "100%" : "auto", maxWidth:560 }}>
                          <div style={{ flex:1, borderRadius:4, overflow:"hidden", alignSelf:"flex-start",
                            boxShadow:"0 20px 60px rgba(0,0,0,0.8), 0 0 0 1px #2e2820" }}>
                            <Chessboard
                              position={analysisFen}
                              boardOrientation="white"
                              arePiecesDraggable={false}
                              customSquareStyles={analysisSqStyles}
                              customDarkSquareStyle={{ backgroundColor:"#5a4a3a" }}
                              customLightSquareStyle={{ backgroundColor:"#d4c5a9" }}
                              customBoardStyle={{ borderRadius:0 }}
                              animationDuration={120}
                            />
                          </div>
                          <EvalBar evaluation={analysisEval?.evaluation}
                            mate={analysisEval?.mate} height={200} />
                        </div>

                        <div style={{ flex:1, minWidth:0, background:"#1a1714", border:"1px solid #2e2820",
                          borderRadius:8, padding:16, display:"flex", flexDirection:"column", gap:12 }}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:12, letterSpacing:2, color:"#6b5f4b",
                              textTransform:"uppercase" }}>{analysisTitle}</div>
                            <div style={{ fontSize:15, color:"#b8a98a", marginTop:5 }}>
                              {analysisPly === 0 ? "Starting position" : analysisMoves[analysisPly - 1]}
                              <span style={{ color:"#4a4035" }}> · {analysisPly}/{analysisMoves.length}</span>
                            </div>
                          </div>

                          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                            <button onClick={() => setAnalysisPly(0)} disabled={analysisPly === 0}
                              style={{ ...gBtn(), opacity: analysisPly === 0 ? 0.4 : 1 }}>⏮</button>
                            <button onClick={() => setAnalysisPly(p => Math.max(0, p - 1))} disabled={analysisPly === 0}
                              style={{ ...gBtn(), opacity: analysisPly === 0 ? 0.4 : 1 }}>← Prev</button>
                            <button onClick={() => setAnalysisPly(p => Math.min(analysisMoves.length, p + 1))}
                              disabled={analysisPly >= analysisMoves.length}
                              style={{ ...gBtn(), opacity: analysisPly >= analysisMoves.length ? 0.4 : 1 }}>Next →</button>
                            <button onClick={() => setAnalysisPly(analysisMoves.length)}
                              disabled={analysisPly >= analysisMoves.length}
                              style={{ ...gBtn(), opacity: analysisPly >= analysisMoves.length ? 0.4 : 1 }}>⏭</button>
                          </div>

                          <div style={{ borderTop:"1px solid #2e2820", paddingTop:12, display:"flex",
                            flexDirection:"column", gap:9 }}>
                            <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
                              <span style={{ fontFamily:"'Courier New', monospace", fontSize:30,
                                color:"#c8a96e" }}>
                                {analysisEval?.success ? formatEval(analysisEval.evaluation, analysisEval.mate) : "—"}
                              </span>
                              {analysisEval?.best && (
                                <span style={{ fontFamily:"'Courier New', monospace", fontSize:15,
                                  color:"#8a7a62" }}>best {analysisEval.best.uci}</span>
                              )}
                            </div>

                            {analysisEval?.loading && (
                              <span style={{ fontSize:15, color:"#8a7a62" }}>Stockfish is thinking…</span>
                            )}
                            {analysisError && (
                              <span style={{ fontSize:14, color:"#e05252" }}>{analysisError}</span>
                            )}
                            {analysisContinuation && (
                              <div>
                                <div style={{ fontSize:12, letterSpacing:2, color:"#4a4035",
                                  textTransform:"uppercase", marginBottom:5 }}>Continuation</div>
                                <div style={{ fontFamily:"'Courier New', monospace", fontSize:15,
                                  color:"#9a8a72", lineHeight:1.6 }}>{analysisContinuation}</div>
                              </div>
                            )}
                            <p style={{ fontSize:14, color:"#4a4035", lineHeight:1.5 }}>
                              Depth {analysisDepth} · board is read-only · moves update the evaluation automatically.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── MY GAMES ────────────────────────────────────────────── */}
                  {section === "history" && (
                    <div>
                      <SectionHeader title="My Games" subtitle="Your last 10 games" isMobile={isMobile}>
                        <button onClick={fetchHistory} disabled={historyLoading}
                          style={{ ...gBtn(), opacity: historyLoading ? 0.6 : 1 }}>
                          {historyLoading ? "Refreshing…" : "Refresh"}
                        </button>
                      </SectionHeader>

                      {historyError && (
                        <p style={{ fontSize:14, color:"#e05252", marginBottom:12 }}>{historyError}</p>
                      )}

                      {historyLoading && gameHistory.length === 0 ? (
                        <div style={{ display:"flex", alignItems:"center", gap:12, padding:"50px 0",
                          color:"#8a7a62" }}>
                          <div style={{ width:28, height:28, border:"2px solid #2e2820",
                            borderTop:"2px solid #c8a96e", borderRadius:"50%",
                            animation:"spin 1s linear infinite" }} />
                          <span style={{ fontSize:15 }}>Loading games…</span>
                        </div>
                      ) : gameHistory.length === 0 ? (
                        <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:8,
                          padding:"36px 20px", textAlign:"center", display:"flex",
                          flexDirection:"column", alignItems:"center", gap:12 }}>
                          <div style={{ fontSize:42, color:"#3a3228" }}>♟</div>
                          <h2 style={{ fontSize:26, fontWeight:400 }}>No games yet</h2>
                          <p style={{ fontSize:15, color:"#6b5f4b" }}>Finish an online or computer game and it will appear here.</p>
                          <button onClick={() => setSection("play")} style={{
                            padding:"11px 20px", background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                            border:"none", borderRadius:5, color:"#0d0d0f", cursor:"pointer",
                            fontFamily:"inherit", fontSize:14, letterSpacing:2, textTransform:"uppercase",
                          }}>Find a Game</button>
                        </div>
                      ) : (
                        <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:12 }}>
                          {gameHistory.map(game => (
                            <HistoryCard key={game._id} game={game} user={authUser}
                              onAnalyse={openGameAnalysis} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── FRIENDS / PRIVATE ROOM ──────────────────────────────── */}
                  {section === "friends" && (
                    <>
                      {(phase === "joinRoom" || phase === "joiningRoom") ? (
                        <div style={{ width:"100%", maxWidth:390, margin:"30px auto 0", background:"#1a1714",
                          border:"1px solid #2e2820", borderRadius:12, padding:"30px 24px",
                          display:"flex", flexDirection:"column", alignItems:"center", gap:16,
                          textAlign:"center", boxShadow:"0 20px 60px rgba(0,0,0,0.5)" }}>
                          <h2 style={{ fontSize:30, fontWeight:400, color:"#e8e0d0" }}>Private Game</h2>
                          <p style={{ fontSize:15, color:"#6b5f4b" }}>You've been invited to a friend's room.</p>

                          <input
                            value={joinCode}
                            onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                            placeholder="ROOM CODE"
                            maxLength={6}
                            style={{ ...authInputStyle, width:"100%", textAlign:"center",
                              fontFamily:"'Courier New', monospace", fontSize:24, letterSpacing:6,
                              color:"#c8a96e", padding:"12px" }}
                            onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                            onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                          />

                          <p style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase", color:"#4a4035" }}>
                            {phase === "joiningRoom" ? "Joining room…" : "Time control is set by the host"}
                          </p>

                          {roomError && <p style={{ fontSize:14, color:"#e05252" }}>{roomError}</p>}

                          <button onClick={joinPrivate} disabled={phase === "joiningRoom"} style={{
                            width:"100%", padding:14,
                            background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                            border:"none", borderRadius:6, color:"#0d0d0f",
                            fontSize:14, letterSpacing:3, textTransform:"uppercase",
                            fontFamily:"inherit", cursor: phase === "joiningRoom" ? "wait" : "pointer",
                            opacity: phase === "joiningRoom" ? 0.7 : 1,
                          }}>Join Game</button>

                          <button onClick={leaveJoinScreen} style={{
                            background:"transparent", border:"none", color:"#4a4035",
                            fontSize:14, letterSpacing:2, textTransform:"uppercase",
                            cursor:"pointer", fontFamily:"inherit",
                          }}>Back to friends</button>
                        </div>
                      ) : phase === "privateWaiting" ? (
                        <div style={{ width:"100%", maxWidth:460, margin:"24px auto 0", background:"#1a1714",
                          border:"1px solid #2e2820", borderRadius:12, padding:"30px 24px",
                          display:"flex", flexDirection:"column", alignItems:"center", gap:16,
                          textAlign:"center", boxShadow:"0 20px 60px rgba(0,0,0,0.5)" }}>
                          <div style={{ width:36, height:36, border:"2px solid #2e2820",
                            borderTop:"2px solid #c8a96e", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
                          <h2 style={{ fontSize:30, fontWeight:400, color:"#e8e0d0" }}>Room Ready</h2>
                          <p style={{ fontSize:15, color:"#6b5f4b" }}>Waiting for opponent…</p>

                          {privateRoom ? (
                            <>
                              <div style={{ fontFamily:"'Courier New', monospace", fontSize:30, letterSpacing:8,
                                color:"#c8a96e", padding:"8px 18px", background:"rgba(200,169,110,0.08)",
                                border:"1px solid #3a3228", borderRadius:8 }}>{privateRoom.code}</div>

                              <div style={{ width:"100%", background:"#0f0e0c", border:"1px solid #1e1a16",
                                borderRadius:6, padding:"10px 12px", fontSize:14, color:"#8a7a62",
                                wordBreak:"break-all", lineHeight:1.5 }}>{shareUrl}</div>

                              <div style={{ display:"flex", gap:8, width:"100%" }}>
                                <button onClick={copyShareLink} style={{
                                  flex:1, padding:12,
                                  background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                                  border:"none", borderRadius:6, color:"#0d0d0f",
                                  fontSize:14, letterSpacing:2, textTransform:"uppercase",
                                  fontFamily:"inherit", cursor:"pointer",
                                }}>{copied ? "Copied!" : "Copy Link"}</button>
                                <button onClick={cancelPrivate} style={gBtn("danger")}>Cancel</button>
                              </div>

                              <p style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase", color:"#4a4035" }}>
                                {privateRoom.timeControl} min game · share the link to invite
                              </p>
                            </>
                          ) : (
                            <p style={{ fontSize:15, color:"#4a4035" }}>Creating room…</p>
                          )}
                        </div>
                      ) : (
                        <div>
                          <SectionHeader title="Friends" subtitle="Private rooms" isMobile={isMobile} />
                          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:12 }}>
                            <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:9,
                              padding:20, display:"flex", flexDirection:"column", gap:13 }}>
                              <h2 style={{ fontSize:24, fontWeight:400 }}>Create a private room</h2>
                              <p style={{ fontSize:14, color:"#8a7a62", lineHeight:1.55 }}>
                                Pick a time control, create a room, and share the link. Your friend joins
                                straight into the game.
                              </p>
                              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:5 }}>
                                {[1,3,5,10].map(tc => (
                                  <button key={tc} onClick={() => setSelectedTC(tc)} style={{
                                    padding:"8px 4px", borderRadius:4, cursor:"pointer", fontFamily:"inherit",
                                    background: selectedTC===tc ? "#c8a96e" : "transparent",
                                    border: `1px solid ${selectedTC===tc ? "#c8a96e" : "#2e2820"}`,
                                    color: selectedTC===tc ? "#0d0d0f" : "#8a7a62", fontSize:15,
                                  }}>{tc}m</button>
                                ))}
                              </div>
                              <button onClick={createPrivate} style={{
                                padding:13, background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                                border:"none", borderRadius:5, color:"#0d0d0f", cursor:"pointer",
                                fontFamily:"inherit", fontSize:14, letterSpacing:2, textTransform:"uppercase",
                              }}>Create Room</button>
                            </div>

                            <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:9,
                              padding:20, display:"flex", flexDirection:"column", gap:13 }}>
                              <h2 style={{ fontSize:24, fontWeight:400 }}>Join with a code</h2>
                              <p style={{ fontSize:14, color:"#8a7a62", lineHeight:1.55 }}>
                                Enter the six-character room code your friend shared with you.
                              </p>
                              <input
                                value={joinCode}
                                onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                                placeholder="ROOM CODE"
                                maxLength={6}
                                style={{ ...authInputStyle, textAlign:"center",
                                  fontFamily:"'Courier New', monospace", fontSize:20, letterSpacing:4 }}
                                onFocus={e => e.currentTarget.style.borderColor = "#c8a96e"}
                                onBlur={e => e.currentTarget.style.borderColor = "#2e2820"}
                              />
                              <button onClick={joinPrivate} style={{
                                padding:13, background:"transparent",
                                border:"1px solid #3a3228", borderRadius:5, color:"#b8a98a",
                                cursor:"pointer", fontFamily:"inherit", fontSize:14,
                                letterSpacing:2, textTransform:"uppercase",
                              }}>Join Room</button>
                              {roomError && <p style={{ fontSize:14, color:"#e05252" }}>{roomError}</p>}
                            </div>
                          </div>

                          <p style={{ fontSize:14, color:"#4a4035", marginTop:16, lineHeight:1.5 }}>
                            Private games are saved to both players' history, exactly like matchmade games.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </main>
          </>
        )}

        {/* ── PROMOTION PICKER ────────────────────────────────────────────────── */}
        {pendingPromo && (
          <div style={{
            position:"fixed", inset:0, background:"rgba(0,0,0,0.72)",
            display:"flex", alignItems:"center", justifyContent:"center",
            zIndex:200, backdropFilter:"blur(6px)", padding:16,
          }} onClick={cancelPromotion}>
            <div style={{
              background:"#1a1714", border:"1px solid #3a3228", borderRadius:12,
              padding:"30px 26px", display:"flex", flexDirection:"column",
              alignItems:"center", gap:18, maxWidth:"100%",
            }} onClick={e => e.stopPropagation()}>
              <p style={{ fontSize:14, letterSpacing:3, textTransform:"uppercase", color:"#6b5f4b" }}>
                {pendingPromo?.isPremove ? "Premove — promote to" : "Promote to"}
              </p>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center" }}>
                {[
                  { piece:"q", label:"Queen",  sym: myColor==="w" ? "♕" : "♛" },
                  { piece:"r", label:"Rook",   sym: myColor==="w" ? "♖" : "♜" },
                  { piece:"b", label:"Bishop", sym: myColor==="w" ? "♗" : "♝" },
                  { piece:"n", label:"Knight", sym: myColor==="w" ? "♘" : "♞" },
                ].map(({ piece, label, sym }) => (
                  <button key={piece} onClick={() => confirmPromotion(piece)} style={{
                    display:"flex", flexDirection:"column", alignItems:"center", gap:6,
                    background:"#201d1a", border:"1px solid #3a3228", borderRadius:10,
                    padding:"16px 18px", cursor:"pointer", transition:"all 0.15s",
                    color:"#e8e0d0", fontFamily:"inherit",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor="#c8a96e"; e.currentTarget.style.background="rgba(200,169,110,0.1)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="#3a3228"; e.currentTarget.style.background="#201d1a"; }}>
                    <span style={{ fontSize:44, lineHeight:1 }}>{sym}</span>
                    <span style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase", color:"#6b5f4b" }}>{label}</span>
                  </button>
                ))}
              </div>
              <button onClick={cancelPromotion} style={{
                background:"transparent", border:"none", color:"#4a4035",
                fontSize:14, letterSpacing:2, textTransform:"uppercase",
                cursor:"pointer", fontFamily:"inherit", marginTop:-4,
              }}>cancel</button>
            </div>
          </div>
        )}

        {/* ── GAME OVER OVERLAY ───────────────────────────────────────────────── */}
        {gameVisible && phase === "ended" && gameOver && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)",
            display:"flex", alignItems:"center", justifyContent:"center",
            zIndex:100, backdropFilter:"blur(4px)", padding:16 }}>
            <div style={{ background:"#1a1714", border:"1px solid #2e2820", borderRadius:12,
              padding:"40px 34px", textAlign:"center", maxWidth:340, width:"100%",
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
                  {gameOver.winnerName && <p style={{ color:"#b8a98a", fontSize:16 }}>{gameOver.winnerName} wins</p>}</>
              )}
              <button onClick={playAgain} style={{
                padding:14, background:"linear-gradient(135deg,#c8a96e 0%,#a07840 100%)",
                border:"none", borderRadius:6, color:"#0d0d0f",
                fontSize:14, letterSpacing:3, textTransform:"uppercase",
                fontFamily:"inherit", cursor:"pointer", marginTop:6,
              }}>Play Again</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const authInputStyle = {
  width:"100%", background:"#131210", border:"1px solid #2e2820",
  borderRadius:6, padding:"11px 13px", color:"#e8e0d0",
  fontSize:16, fontFamily:"inherit", outline:"none",
  transition:"border-color 0.15s",
};

function gBtn(variant) {
  return {
    padding:"8px 16px", border:`1px solid ${variant==="danger" ? "#6b2020" : "#2e2820"}`,
    borderRadius:5, background:"transparent",
    color: variant==="danger" ? "#e05252" : "#6b5f4b",
    fontSize:14, letterSpacing:2, textTransform:"uppercase",
    fontFamily:"inherit", cursor:"pointer",
  };
}
