const { Chess } = require("chess.js");
const GameModel = require("./models/Game");

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
//   turnStart: Date,
//   timerRef: NodeJS timer,
//   status: 'active' | 'ended',
// }
const activeGames = {};

// privateRooms[roomCode] = { socketId, timeControl, createdAt }
const privateRooms = {};

// playerNames[socketId] = string (authenticated username)
const playerNames = {};

// playerUserIds[socketId] = authenticated MongoDB user id
const playerUserIds = {};

// socketRoom[socketId] = roomId  (for quick lookup on disconnect)
const socketRoom = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getRoomId() {
  return `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function registerPlayer(socketId, username, userId) {
  playerNames[socketId] = username;
  playerUserIds[socketId] = userId;
  return username;
}

function getPlayerName(socketId) {
  return playerNames[socketId] || "Player";
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────
function createGame(white, black, timeControl) {
  const roomId = getRoomId();
  const tcMs = Number(timeControl) * 60 * 1000;

  const game = {
    chess: new Chess(),
    white,
    black,
    whiteName: getPlayerName(white),
    blackName: getPlayerName(black),
    whiteUserId: playerUserIds[white] || null,
    blackUserId: playerUserIds[black] || null,
    timeControl: Number(timeControl),
    clocks: { w: tcMs, b: tcMs },
    turnStart: new Date(),
    timerRef: null,
    status: "active",
    saved: false,
  };

  activeGames[roomId] = game;
  socketRoom[white] = roomId;
  socketRoom[black] = roomId;

  return { matched: true, roomId, game, white, black };
}

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

    return createGame(white, black, tc);
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

// ─── Private rooms ───────────────────────────────────────────────────────────
function createPrivateRoom(socketId, timeControl) {
  // A player can only host one private room at a time.
  for (const [code, room] of Object.entries(privateRooms)) {
    if (room.socketId === socketId) delete privateRooms[code];
  }

  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (code.length < 6 || privateRooms[code]);

  privateRooms[code] = {
    socketId,
    timeControl: Number(timeControl),
    createdAt: Date.now(),
  };

  return code;
}

/**
 * Pair the joining socket with the private room's host.
 * Returns { error } or { matched: true, roomId, game, white, black }.
 */
function joinPrivateRoom(socketId, code, io) {
  const key = String(code || "").trim().toUpperCase();
  const room = privateRooms[key];

  if (!room) return { error: "Room not found" };
  if (room.socketId === socketId) return { error: "Cannot join your own room" };

  // Host may have disconnected while waiting.
  if (!io.sockets.sockets.has(room.socketId)) {
    delete privateRooms[key];
    return { error: "Room no longer available" };
  }

  delete privateRooms[key];

  const [white, black] =
    Math.random() < 0.5
      ? [room.socketId, socketId]
      : [socketId, room.socketId];

  return createGame(white, black, room.timeControl);
}

function cancelPrivateRoom(socketId, code) {
  const key = String(code || "").trim().toUpperCase();
  if (privateRooms[key]?.socketId === socketId) {
    delete privateRooms[key];
    return true;
  }
  return false;
}

// Expire private rooms that were never joined (10 minutes).
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [code, room] of Object.entries(privateRooms)) {
    if (room.createdAt < cutoff) delete privateRooms[code];
  }
}, 60 * 1000).unref();

// ─── Game persistence ────────────────────────────────────────────────────────
function resultFromWinner(winner) {
  if (winner === "w") return "1-0";
  if (winner === "b") return "0-1";
  return "1/2-1/2";
}

async function saveGame(game, winner, termination) {
  if (!game || game.saved) return;
  game.saved = true;

  const result = resultFromWinner(winner);
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    game.chess.header(
      "White", game.whiteName,
      "Black", game.blackName,
      "Result", result,
      "TimeControl", `${game.timeControl * 60}`,
      "Date", today
    );

    await GameModel.create({
      white: { userId: game.whiteUserId || undefined, username: game.whiteName },
      black: { userId: game.blackUserId || undefined, username: game.blackName },
      result,
      termination,
      timeControl: String(game.timeControl),
      moves: game.chess.history(),
      pgn: game.chess.pgn(),
      finalFen: game.chess.fen(),
    });
  } catch (err) {
    console.error("Failed to save game:", err.message);
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

      const winnerColor = turn === "w" ? "b" : "w";
      saveGame(g, winnerColor, "timeout");
      io.to(roomId).emit("gameOver", {
        reason: "timeout",
        winner: winnerColor,
        winnerName: turn === "w" ? g.blackName : g.whiteName,
        clocks: g.clocks,
      });
    } else {
      // Broadcast live clock every second — clients interpolate between ticks.
      const clocks = {
        w: turn === "w" ? remaining : g.clocks.w,
        b: turn === "b" ? remaining : g.clocks.b,
      };
      io.to(roomId).emit("clockUpdate", { clocks, turn });
    }
  }, 1000);
}

function stopClock(roomId, color) {
  const game = activeGames[roomId];
  if (!game) return;
  clearInterval(game.timerRef);
  game.timerRef = null;
  // Deduct elapsed time from the clock of the player whose turn just ended.
  // `color` is passed in by applyMove because chess.turn() has already flipped
  // to the opponent by the time the move is applied.
  const turn = color || game.chess.turn();
  if (game.turnStart) {
    const elapsed = Date.now() - game.turnStart.getTime();
    game.clocks[turn] = Math.max(0, game.clocks[turn] - elapsed);
  }
  // The opponent's clock starts now.
  game.turnStart = new Date();
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

  // Deduct the mover's elapsed time first, then broadcast the updated clocks.
  // move.color is the side that just moved (game.chess.turn() is now the opponent).
  stopClock(roomId, move.color);

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
    saveGame(game, winner, reason);
  }

  return result;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
function handleDisconnect(socketId, io) {
  leaveQueue(socketId);
  delete playerNames[socketId];
  delete playerUserIds[socketId];

  for (const [code, room] of Object.entries(privateRooms)) {
    if (room.socketId === socketId) delete privateRooms[code];
  }

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

  saveGame(game, winner, "opponent disconnected");

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
  registerPlayer,
  getPlayerName,
  createGame,
  createPrivateRoom,
  joinPrivateRoom,
  cancelPrivateRoom,
  saveGame,
  privateRooms,
  activeGames,
  socketRoom,
};