<div align="center">

```
  ♜ ♞ ♝ ♛ ♚ ♝ ♞ ♜
  ♟ ♟ ♟ ♟ ♟ ♟ ♟ ♟
```

# ♟ BlitzBoard

### Real-Time Multiplayer Chess Engine

*Server-validated · WebSocket-powered · Premoves · Live clocks · In-game chat*

---

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.x-010101?style=flat-square&logo=socket.io)](https://socket.io)
[![chess.js](https://img.shields.io/badge/chess.js-1.x-8B4513?style=flat-square)](https://github.com/jhlywa/chess.js)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Feature List](#feature-list)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Architecture Deep Dive](#architecture-deep-dive)
  - [Matchmaking](#matchmaking)
  - [Move Security](#move-security)
  - [Clock System](#clock-system)
  - [Premove System](#premove-system)
  - [In-Memory State](#in-memory-state)
- [Socket Events Reference](#socket-events-reference)
- [Environment Variables](#environment-variables)
- [Deployment Guide](#deployment-guide)
- [Roadmap](#roadmap)

---

## Overview

BlitzBoard is a full-stack real-time chess application where two players are matched instantly by time control, play on a live board with per-player clocks, and communicate via in-game chat. All move validation happens **server-side** — the client can never cheat by sending illegal or out-of-turn moves.

The server is the single source of truth. Every move is validated by a `chess.js` instance running on the backend before the updated FEN is broadcast to both players. The frontend only renders what the server confirms.

---

## Feature List

| Feature | Details |
|---|---|
| 🔁 **Matchmaking** | Queue by time control; random color assignment; anonymous generated names |
| ⚡ **Time Controls** | 1 · 3 · 5 · 10 minute games |
| ✅ **Server Validation** | All moves validated by `chess.js` on the server — illegal & out-of-turn moves rejected |
| ⏱ **Live Clocks** | Per-player countdown clocks, ticking every 250ms, deducted server-side on each move |
| 🖱 **Click-to-Move** | Click a piece to see legal move dots, click a destination to move |
| 🖐 **Drag-and-Drop** | Drag pieces to any square; illegal moves snap back |
| 👻 **Premoves** | Queue a move during the opponent's turn; auto-fires when your turn arrives |
| 👑 **Promotion Picker** | Full UI modal for choosing Queen / Rook / Bishop / Knight on promotion — including for premoves |
| 💬 **In-Game Chat** | Real-time messaging between players via Socket.io, relayed server-side |
| 📜 **Move History** | Scrolling algebraic notation panel, server-authoritative, updates live |
| 🔴 **Check Highlight** | King square glows red; board border pulses on check |
| 🟡 **Last Move Highlight** | From/to squares highlighted in gold after every move |
| 🏳 **Draw Offers** | Offer, accept, or decline draws mid-game |
| 🚩 **Resign** | Forfeit with confirmation dialog |
| 💀 **Disconnect Handling** | Opponent wins automatically if a player disconnects mid-game |
| 📱 **Responsive** | Board and side panel reflow for mobile screens |

---

## Tech Stack

### Backend

| Package | Version | Role |
|---|---|---|
| `express` | ^4.18 | HTTP server & health endpoint |
| `socket.io` | ^4.7 | WebSocket server, room management |
| `chess.js` | ^1.0 | Server-side move validation & game state |
| `cors` | ^2.8 | Cross-origin request handling |

### Frontend

| Package | Version | Role |
|---|---|---|
| `react` | ^18.2 | UI framework |
| `react-chessboard` | ^4.6 | Interactive board rendering |
| `chess.js` | ^1.0 | Client-side move legality (for hints only) |
| `socket.io-client` | ^4.7 | WebSocket client |

---

## Project Structure

```
chess-app/
│
├── chess-backend/
│   ├── package.json          # Backend dependencies
│   ├── server.js             # Express + Socket.io setup, all event handlers
│   └── gameLogic.js          # Matchmaking, move validation, clock engine, name generator
│
└── chess-frontend/
    ├── package.json          # Frontend dependencies
    └── src/
        ├── index.js          # React entry point
        └── App.jsx           # Entire UI — board, clocks, chat, move history, modals
```

### File Responsibilities

| File | Responsibility |
|---|---|
| `server.js` | Initialises Express + Socket.io. Routes all socket events to `gameLogic`. Broadcasts results back to rooms. |
| `gameLogic.js` | Owns all in-memory state. Handles matchmaking queues, move application, clock ticks, disconnect forfeits, and name generation. |
| `App.jsx` | Single-component React UI. Manages socket lifecycle, all local UI state (selected squares, premoves, promotion picker, chat). Renders board, player rows, clocks, move history, chat, and overlays. |

---

## Quick Start

### Prerequisites

- **Node.js** v18 or higher
- **npm** v8 or higher

### 1 · Clone & install

```bash
git clone https://github.com/your-username/chess-app.git
cd chess-app
```

### 2 · Start the backend

```bash
cd chess-backend
npm install
npm start
# Server running on http://localhost:8080
```

For development with hot-reload:

```bash
npx nodemon server.js
```

### 3 · Start the frontend

```bash
cd chess-frontend
npm install
npm start
# App running on http://localhost:3000
```

### 4 · Play

Open **two browser tabs** at `http://localhost:3000`, select the same time control in both, click **Find Opponent** — they'll match instantly.

---

## Architecture Deep Dive

### Matchmaking

Players are grouped into queues by time control. When two sockets request the same time control, they are popped from the queue, assigned to a unique room, and given random colors and anonymous generated names (e.g. *Crimson Tactician*, *Silent Oracle*).

```
Player A                    Server                      Player B
   │                           │                           │
   │── findGame({ tc: 5 }) ───▶│                           │
   │                    queue["5"] = [A]                   │
   │◀── waitingForOpponent ────│                           │
   │                           │◀── findGame({ tc: 5 }) ──│
   │                    queue["5"].length >= 2             │
   │                    create roomId, assign colors       │
   │◀────────────── gameStart({ color:"w", ... }) ────────│
   │──────────────── gameStart({ color:"b", ... }) ───────▶│
   │                    startClock(roomId)                 │
```

### Move Security

The server is the **only** authority on whether a move is legal. The client sends intent; the server decides.

```
Client emits makeMove({ roomId, move: { from, to, promotion? } })
    │
    ├─ Is socket.id the active player for this room?  ──── No  ──▶ emit moveRejected("Not your turn")
    │
    ├─ Does chess.js accept the move?  ───────────────────── No  ──▶ emit moveRejected("Illegal move")
    │
    ├─ stopClock() — deduct elapsed time from active player's clock
    │
    ├─ Broadcast moveUpdate({ fen, turn, move, clocks, san, history }) to entire room
    │
    └─ chess.isGameOver()?
         ├─ Checkmate  ──▶ gameOver({ reason: "checkmate", winner, winnerName })
         ├─ Stalemate  ──▶ gameOver({ reason: "stalemate", winner: null })
         ├─ Threefold  ──▶ gameOver({ reason: "threefold repetition", winner: null })
         └─ Insufficient material ──▶ gameOver({ reason: "insufficient material", winner: null })
```

### Clock System

| Step | What happens |
|---|---|
| Game starts | `startClock(roomId)` sets a 250ms interval |
| Each tick | Computes `remaining = storedClock - elapsed` for the active player and emits `clockUpdate` |
| Player moves | `stopClock()` deducts elapsed from that player's stored clock before switching turns |
| New turn | `startClock()` resets `turnStart` and restarts the interval |
| Clock hits zero | Interval cleared, `gameOver({ reason: "timeout" })` broadcast |

Clocks are **never trusted from the client** — all time deduction happens on the server.

### Premove System

A premove is a move queued while it is the opponent's turn. It fires automatically as soon as the turn flips.

```
Opponent's turn                    Your turn arrives
      │                                   │
User drags/clicks                  moveUpdate received
pawn to promo square               turn === myColor
      │                                   │
Promotion picker shown          Read premoveRef.current
(isPremove: true label)                   │
      │                         Validate still legal?
User picks piece                          │
      │                         ├─ Yes → emit makeMove
setPremove({ from, to,          └─ No  → silently discard
  promotion: "r" })
```

The premove is stored in a `ref` (not state) so the `useEffect` that fires it always reads the latest value without stale closure issues.

### In-Memory State

All game state lives in three objects inside `gameLogic.js`:

| Object | Key | Value |
|---|---|---|
| `queues` | `timeControl` (string) | `[ socketId, ... ]` — waiting players |
| `activeGames` | `roomId` | Full game object (see below) |
| `socketRoom` | `socketId` | `roomId` — for O(1) disconnect lookup |

**Game object shape:**

```js
{
  chess:       Chess,        // chess.js instance — the live game state
  white:       socketId,     // socket ID of the white player
  black:       socketId,     // socket ID of the black player
  whiteName:   string,       // generated name, e.g. "Blazing Arbiter"
  blackName:   string,
  timeControl: number,       // minutes
  clocks:      { w: ms, b: ms },
  turnStart:   Date,         // when the current player's clock started
  timerRef:    NodeTimer,    // reference to the active setInterval
  status:      "active" | "ended",
}
```

---

## Socket Events Reference

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `findGame` | `{ timeControl: "1" \| "3" \| "5" \| "10" }` | Join the matchmaking queue for a time control |
| `cancelQueue` | — | Leave the queue before being matched |
| `makeMove` | `{ roomId, move: { from, to, promotion? } }` | Submit a move for server validation |
| `resign` | `{ roomId }` | Forfeit the current game |
| `offerDraw` | `{ roomId }` | Propose a draw to the opponent |
| `acceptDraw` | `{ roomId }` | Accept the opponent's draw proposal |
| `declineDraw` | `{ roomId }` | Decline the opponent's draw proposal |
| `chatMessage` | `{ roomId, text }` | Send a chat message (max 120 chars) |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `assignedName` | `{ name }` | Random name assigned on connection |
| `waitingForOpponent` | `{ timeControl }` | Queued, waiting for a match |
| `queueCancelled` | — | Successfully left the queue |
| `gameStart` | `{ roomId, color, opponentName, myName, fen, timeControl, clocks, turn }` | Match found — game begins |
| `moveUpdate` | `{ fen, turn, move, clocks, san, history }` | Broadcast after every legal move |
| `clockUpdate` | `{ clocks }` | Live clock tick, every 250ms |
| `moveRejected` | `{ reason }` | Submitted move was illegal or out-of-turn |
| `gameOver` | `{ reason, winner, winnerName, clocks }` | Game has ended |
| `drawOffered` | — | Opponent is proposing a draw |
| `drawDeclined` | — | Opponent declined your draw offer |
| `chatMessage` | `{ from, text }` | Incoming chat message from opponent |

### `gameOver` Reason Values

| Value | Trigger |
|---|---|
| `"checkmate"` | King in check with no legal moves |
| `"stalemate"` | No legal moves but not in check |
| `"threefold repetition"` | Same position reached 3 times |
| `"insufficient material"` | Neither side can force checkmate |
| `"timeout"` | A player's clock reached zero |
| `"resignation"` | A player resigned |
| `"draw by agreement"` | Both players accepted a draw |
| `"opponent disconnected"` | Opponent's socket closed mid-game |

---

## Environment Variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the HTTP + WebSocket server listens on |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `REACT_APP_SOCKET_URL` | `http://localhost:8080` | Full URL of the backend server |

Set `REACT_APP_SOCKET_URL` before building for production:

```bash
REACT_APP_SOCKET_URL=https://your-backend.railway.app npm run build
```

---

## Deployment Guide

### Backend → Railway

1. Push the repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Set **Root Directory** to `chess-backend`
4. Railway auto-detects Node.js and runs `npm start`
5. Go to **Settings → Networking → Generate Domain** to get your public URL

> Do **not** set a `PORT` variable — Railway injects it automatically.

### Frontend → Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project → Import** your repo
2. Set **Root Directory** to `chess-frontend`
3. Add environment variable:

   | Key | Value |
   |---|---|
   | `REACT_APP_SOCKET_URL` | `https://your-backend.up.railway.app` |

4. Deploy — Vercel runs `npm run build` automatically

### Cost

| Platform | Service | Free Tier |
|---|---|---|
| Railway | Node.js backend + Socket.io | 500 hrs / month |
| Vercel | React frontend (static) | Unlimited |

---

## Roadmap

| Feature | Status |
|---|---|
| ✅ Matchmaking by time control | Done |
| ✅ Server-side move validation | Done |
| ✅ Live per-player clocks | Done |
| ✅ Click-to-move with move hints | Done |
| ✅ Drag-and-drop | Done |
| ✅ Premoves with promotion picker | Done |
| ✅ In-game chat | Done |
| ✅ Move history (algebraic notation) | Done |
| ✅ Check / checkmate visuals | Done |
| ✅ Draw offers & resign | Done |
| 🔲 Rematch button | Planned |
| 🔲 Opening name detection (ECO) | Planned |
| 🔲 Move sounds | Planned |
| 🔲 Spectator mode | Planned |
| 🔲 ELO rating system | Planned |
| 🔲 Game history / replay | Planned |
| 🔲 Redis adapter for horizontal scaling | Planned |

---

<div align="center">

*Built with Node.js · React · Socket.io · chess.js*

```
  ♙ ♙ ♙ ♙ ♙ ♙ ♙ ♙
  ♖ ♘ ♗ ♕ ♔ ♗ ♘ ♖
```

</div>
