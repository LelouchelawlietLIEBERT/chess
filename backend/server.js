require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { Chess } = require("chess.js");

const authRouter = require("./routes/auth");
const GameModel = require("./models/Game");
const {
  joinQueue,
  leaveQueue,
  applyMove,
  startClock,
  handleDisconnect,
  registerPlayer,
  createPrivateRoom,
  joinPrivateRoom,
  cancelPrivateRoom,
  saveGame,
  activeGames,
} = require("./gameLogic");

const JWT_SECRET = process.env.JWT_SECRET || "blitzboard_dev_secret";

// ─── App setup ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.use("/auth", authRouter);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/blitzboard")
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err.message));

// ─── Socket.io auth middleware ───────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.username = decoded.username;
    socket.data.userId = decoded.userId;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

// ─── REST auth middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ─── Game history ────────────────────────────────────────────────────────────
app.get("/games/history", requireAuth, async (req, res) => {
  try {
    const games = await GameModel.find({
      $or: [{ "white.userId": req.userId }, { "black.userId": req.userId }],
    })
      .sort({ playedAt: -1 })
      .limit(10)
      .lean();

    res.json(games);
  } catch (err) {
    console.error("History error:", err);
    res.status(500).json({ error: "Could not load game history" });
  }
});

// Save a client-side game (vs Computer) to the player's history.
app.post("/games", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const rawMoves = Array.isArray(body.moves) ? body.moves.slice(0, 500) : [];
    const result = ["1-0", "0-1", "1/2-1/2"].includes(body.result)
      ? body.result
      : "1/2-1/2";
    const playerColor = body.playerColor === "b" ? "b" : "w";
    const opponentName = String(body.opponentName || "Stockfish").slice(0, 40);
    const termination = String(body.termination || "unknown").slice(0, 60);
    const timeControl = String(body.timeControl || "unlimited").slice(0, 12);

    // Replay the moves so the stored PGN/FEN cannot be spoofed independently.
    const chess = new Chess();
    for (const san of rawMoves) {
      try {
        if (!chess.move(String(san))) throw new Error("Illegal move");
      } catch {
        return res.status(400).json({ error: "Invalid move list" });
      }
    }

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    const white = playerColor === "w"
      ? { userId: req.userId, username: req.username }
      : { username: opponentName };
    const black = playerColor === "b"
      ? { userId: req.userId, username: req.username }
      : { username: opponentName };

    chess.header(
      "White", white.username,
      "Black", black.username,
      "Result", result,
      "TimeControl", timeControl === "unlimited" ? "-" : String(Number(timeControl) * 60),
      "Date", today
    );

    const game = await GameModel.create({
      white,
      black,
      result,
      termination,
      timeControl,
      moves: chess.history(),
      pgn: chess.pgn(),
      finalFen: chess.fen(),
    });

    return res.status(201).json(game);
  } catch (err) {
    console.error("Save game error:", err);
    return res.status(500).json({ error: "Could not save game" });
  }
});

// ─── REST health check ───────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    activeGames: Object.keys(activeGames).length,
    timestamp: new Date().toISOString(),
  });
});

// ─── Game start helper ───────────────────────────────────────────────────────
function startMatchedGame(result) {
  const { roomId, game, white, black } = result;

  const whiteSocket = io.sockets.sockets.get(white);
  const blackSocket = io.sockets.sockets.get(black);

  if (whiteSocket) whiteSocket.join(roomId);
  if (blackSocket) blackSocket.join(roomId);

  if (whiteSocket) {
    whiteSocket.emit("gameStart", {
      roomId,
      color: "w",
      opponentName: game.blackName,
      myName: game.whiteName,
      fen: game.chess.fen(),
      timeControl: game.timeControl,
      clocks: game.clocks,
      turn: "w",
    });
  }

  if (blackSocket) {
    blackSocket.emit("gameStart", {
      roomId,
      color: "b",
      opponentName: game.whiteName,
      myName: game.blackName,
      fen: game.chess.fen(),
      timeControl: game.timeControl,
      clocks: game.clocks,
      turn: "w",
    });
  }

  console.log(
    `[Game] ${roomId} | ${game.whiteName} (w) vs ${game.blackName} (b) | ${game.timeControl}m`
  );

  startClock(roomId, io);
}

// ─── Socket.io event handlers ─────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id} (${socket.data.username})`);

  // ── Authenticated username ─────────────────────────────────────────────────
  registerPlayer(socket.id, socket.data.username, socket.data.userId);
  socket.emit("assignedName", { name: socket.data.username });

  // ── Matchmaking ────────────────────────────────────────────────────────────
  // Client sends: { timeControl: 1 | 3 | 5 | 10 }
  socket.on("findGame", ({ timeControl }) => {
    const validTCs = [1, 3, 5, 10];
    if (!validTCs.includes(Number(timeControl))) {
      socket.emit("error", { message: "Invalid time control" });
      return;
    }

    const result = joinQueue(socket.id, timeControl, io);

    if (result.matched) {
      startMatchedGame(result);
    } else {
      socket.emit("waitingForOpponent", { timeControl });
      console.log(`[Queue] ${socket.id} waiting for ${timeControl}m game`);
    }
  });

  // ── Private rooms ──────────────────────────────────────────────────────────
  socket.on("createPrivateRoom", ({ timeControl } = {}) => {
    const validTCs = [1, 3, 5, 10];
    if (!validTCs.includes(Number(timeControl))) {
      socket.emit("roomError", { message: "Invalid time control" });
      return;
    }

    leaveQueue(socket.id);
    const code = createPrivateRoom(socket.id, timeControl);
    socket.emit("privateRoomCreated", { code, timeControl: Number(timeControl) });
    console.log(`[Private] ${socket.data.username} created room ${code}`);
  });

  socket.on("joinPrivateRoom", ({ code } = {}) => {
    const result = joinPrivateRoom(socket.id, code, io);

    if (result.error) {
      socket.emit("roomError", { message: result.error });
      return;
    }

    leaveQueue(socket.id);
    startMatchedGame(result);
  });

  socket.on("cancelPrivateRoom", ({ code } = {}) => {
    cancelPrivateRoom(socket.id, code);
    socket.emit("privateRoomCancelled");
  });

  // ── Move ───────────────────────────────────────────────────────────────────
  // Client sends: { roomId, move: { from, to, promotion? } }
  socket.on("makeMove", ({ roomId, move }) => {
    const result = applyMove(roomId, socket.id, move);

    if (!result.ok) {
      socket.emit("moveRejected", { reason: result.reason });
      return;
    }

    // Broadcast updated state to entire room
    // history[] is the full SAN move list so the frontend never has to derive it from chess.history()
    io.to(roomId).emit("moveUpdate", {
      fen: result.fen,
      turn: result.turn,
      move: result.move,
      clocks: result.clocks,
      san: result.san,
      history: result.history,
    });

    if (result.gameOver) {
      io.to(roomId).emit("gameOver", {
        ...result.gameOver,
        clocks: result.clocks,
      });
      console.log(
        `[Game Over] ${roomId} — ${result.gameOver.reason}${
          result.gameOver.winner ? ` | Winner: ${result.gameOver.winnerName}` : ""
        }`
      );
    } else {
      // Resume clock for next player
      const game = activeGames[roomId];
      if (game) startClock(roomId, io);
    }
  });

  // ── Resign ─────────────────────────────────────────────────────────────────
  socket.on("resign", ({ roomId }) => {
    const game = activeGames[roomId];
    if (!game || game.status !== "active") return;

    game.status = "ended";
    clearInterval(game.timerRef);

    const loserColor = socket.id === game.white ? "w" : "b";
    const winner = loserColor === "w" ? "b" : "w";
    const winnerName = winner === "w" ? game.whiteName : game.blackName;

    saveGame(game, winner, "resignation");

    io.to(roomId).emit("gameOver", {
      reason: "resignation",
      winner,
      winnerName,
      clocks: game.clocks,
    });

    console.log(`[Resign] ${roomId} | ${winnerName} wins by resignation`);
  });

  // ── Offer / Accept Draw ────────────────────────────────────────────────────
  socket.on("offerDraw", ({ roomId }) => {
    socket.to(roomId).emit("drawOffered");
  });

  socket.on("acceptDraw", ({ roomId }) => {
    const game = activeGames[roomId];
    if (!game || game.status !== "active") return;

    game.status = "ended";
    clearInterval(game.timerRef);

    saveGame(game, null, "draw by agreement");

    io.to(roomId).emit("gameOver", {
      reason: "draw by agreement",
      winner: null,
      winnerName: null,
      clocks: game.clocks,
    });
  });

  socket.on("declineDraw", ({ roomId }) => {
    socket.to(roomId).emit("drawDeclined");
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on("chatMessage", ({ roomId, text }) => {
    const game = activeGames[roomId];
    if (!game) return;
    const name = game.white === socket.id ? game.whiteName : game.blackName;
    if (!name) return;
    const clean = String(text).slice(0, 120);
    // Relay only to opponent (sender echoes locally)
    socket.to(roomId).emit("chatMessage", { from: name, text: clean });
  });

  // ── Cancel queue ───────────────────────────────────────────────────────────
  socket.on("cancelQueue", () => {
    leaveQueue(socket.id);
    socket.emit("queueCancelled");
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    handleDisconnect(socket.id, io);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0",() => {
  console.log(`♟  Chess server running on http://localhost:${PORT}`);
});
