const { Chess } = require("chess.js");

// ─── Adjective + Noun name generator ────────────────────────────────────────
const ADJECTIVES = [
  "Silent", "Fierce", "Ancient", "Cunning", "Reckless", "Stoic",
  "Phantom", "Crimson", "Obsidian", "Golden", "Iron", "Swift",
  "Ruthless", "Hollow", "Feral", "Marble", "Ashen", "Blazing",
];
const NOUNS = [
  "Bishop", "Knight", "Rook", "Gambit", "Pawn", "Monarch",
  "Tactician", "Sovereign", "Oracle", "Crusader", "Sentinel", "Shadow",
  "Champion", "Warlord", "Arbiter", "Pilgrim", "Phantom", "Exile",
];

function generateName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

// ─── In-memory state ─────────────────────────────────────────────────────────
// queues[timeControl] = [socketId, ...]
const queues = {};

// activeGames[roomId] = {
//   chess: Chess instance,
//   white: socketId,
//   black: socketId,
//   whiteName: string,
//   blackName: string,
//   timeControl: number (seconds),
//   clocks: { w: ms, b: ms },
//   lastMoveAt: Date | null,
//   turnStart: Date,
//   timerRef: NodeJS timer,
//   status: 'active' | 'ended',
// }
const activeGames = {};

// playerNames[socketId] = string
const playerNames = {};

// socketRoom[socketId] = roomId  (for quick lookup on disconnect)
const socketRoom = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getRoomId() {
  return `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getOrAssignName(socketId) {
  if (!playerNames[socketId]) {
    playerNames[socketId] = generateName();
  }
  return playerNames[socketId];
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────
/**
 * Attempt to match the joining socket with an existing waiter.
 * Returns { matched: false } or { matched: true, roomId, game }
 */
function joinQueue(socketId, timeControl, io) {
  const tc = String(timeControl);
  if (!queues[tc]) queues[tc] = [];

  // Remove stale / disconnected sockets from queue
  queues[tc] = queues[tc].filter((id) => {
    const sockets = io.sockets.sockets;
    return sockets.has(id);
  });

  if (queues[tc].length > 0) {
    // Match found — pop the waiter
    const opponentId = queues[tc].shift();

    // Assign colours randomly
    const [white, black] =
      Math.random() < 0.5
        ? [socketId, opponentId]
        : [opponentId, socketId];

    const roomId = getRoomId();
    const tcMs = Number(tc) * 60 * 1000;

    const game = {
      chess: new Chess(),
      white,
      black,
      whiteName: getOrAssignName(white),
      blackName: getOrAssignName(black),
      timeControl: Number(tc),
      clocks: { w: tcMs, b: tcMs },
      lastMoveAt: null,
      turnStart: new Date(),
      timerRef: null,
      status: "active",
    };

    activeGames[roomId] = game;
    socketRoom[white] = roomId;
    socketRoom[black] = roomId;

    return { matched: true, roomId, game, white, black };
  } else {
    // No match — add to queue
    queues[tc].push(socketId);
    return { matched: false };
  }
}

function leaveQueue(socketId) {
  for (const tc of Object.keys(queues)) {
    queues[tc] = queues[tc].filter((id) => id !== socketId);
  }
}

// ─── Clock management ────────────────────────────────────────────────────────
function startClock(roomId, io) {
  const game = activeGames[roomId];
  if (!game || game.status !== "active") return;

  clearInterval(game.timerRef);
  game.turnStart = new Date();

  game.timerRef = setInterval(() => {
    const g = activeGames[roomId];
    if (!g || g.status !== "active") {
      clearInterval(game.timerRef);
      return;
    }

    const turn = g.chess.turn(); // 'w' or 'b'
    const elapsed = Date.now() - g.turnStart.getTime();
    const remaining = g.clocks[turn] - elapsed;

    if (remaining <= 0) {
      g.clocks[turn] = 0;
      g.status = "ended";
      clearInterval(g.timerRef);

      const loser = turn === "w" ? g.white : g.black;
      const winner = turn === "w" ? g.black : g.white;
      io.to(roomId).emit("gameOver", {
        reason: "timeout",
        winner: turn === "w" ? "b" : "w",
        winnerName: turn === "w" ? g.blackName : g.whiteName,
        clocks: g.clocks,
      });
    } else {
      // Broadcast live clock every second
      const clocks = {
        w: turn === "w" ? remaining : g.clocks.w,
        b: turn === "b" ? remaining : g.clocks.b,
      };
      io.to(roomId).emit("clockUpdate", { clocks });
    }
  }, 250); // tick every 250 ms for smooth UI
}

function stopClock(roomId) {
  const game = activeGames[roomId];
  if (!game) return;
  clearInterval(game.timerRef);
  // Deduct elapsed time from the clock of the player whose turn just ended
  const turn = game.chess.turn();
  if (game.turnStart) {
    const elapsed = Date.now() - game.turnStart.getTime();
    game.clocks[turn] = Math.max(0, game.clocks[turn] - elapsed);
  }
}

// ─── Move validation ─────────────────────────────────────────────────────────
/**
 * Returns { ok: true, fen, turn, move, clocks, gameOver? }
 *      or { ok: false, reason }
 */
function applyMove(roomId, socketId, movePayload) {
  const game = activeGames[roomId];
  if (!game) return { ok: false, reason: "Game not found" };
  if (game.status !== "active") return { ok: false, reason: "Game is over" };

  const turn = game.chess.turn(); // 'w' or 'b'

  // Out-of-turn check
  const expectedSocket = turn === "w" ? game.white : game.black;
  if (socketId !== expectedSocket) {
    return { ok: false, reason: "Not your turn" };
  }

  // Attempt move
  let move;
  try {
    move = game.chess.move(movePayload); // chess.js throws on illegal move
  } catch (e) {
    return { ok: false, reason: "Illegal move" };
  }

  if (!move) return { ok: false, reason: "Illegal move" };

  // Update clocks
  stopClock(roomId);

  const result = {
    ok: true,
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    move,
    san: move.san,
    history: game.chess.history(),
    clocks: { ...game.clocks },
  };

  // Check for game-ending conditions
  if (game.chess.isGameOver()) {
    game.status = "ended";
    clearInterval(game.timerRef);

    let reason = "unknown";
    let winner = null;
    let winnerName = null;

    if (game.chess.isCheckmate()) {
      reason = "checkmate";
      winner = move.color; // the one who just moved wins
      winnerName = winner === "w" ? game.whiteName : game.blackName;
    } else if (game.chess.isDraw()) {
      reason = game.chess.isStalemate()
        ? "stalemate"
        : game.chess.isThreefoldRepetition()
        ? "threefold repetition"
        : game.chess.isInsufficientMaterial()
        ? "insufficient material"
        : "draw";
    }

    result.gameOver = { reason, winner, winnerName };
  }

  return result;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
function handleDisconnect(socketId, io) {
  leaveQueue(socketId);
  delete playerNames[socketId];

  const roomId = socketRoom[socketId];
  if (!roomId) return;

  const game = activeGames[roomId];
  if (!game || game.status !== "active") {
    delete socketRoom[socketId];
    return;
  }

  game.status = "ended";
  clearInterval(game.timerRef);

  const winner = socketId === game.white ? "b" : "w";
  const winnerName = winner === "w" ? game.whiteName : game.blackName;

  io.to(roomId).emit("gameOver", {
    reason: "opponent disconnected",
    winner,
    winnerName,
    clocks: game.clocks,
  });

  delete socketRoom[game.white];
  delete socketRoom[game.black];
  delete activeGames[roomId];
}

module.exports = {
  joinQueue,
  leaveQueue,
  applyMove,
  startClock,
  stopClock,
  handleDisconnect,
  getOrAssignName,
  activeGames,
  socketRoom,
};