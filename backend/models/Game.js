const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema({
  white:       { userId: mongoose.Schema.Types.ObjectId, username: String },
  black:       { userId: mongoose.Schema.Types.ObjectId, username: String },
  result:      { type: String, enum: ["1-0", "0-1", "1/2-1/2"] },
  termination: { type: String }, // "checkmate", "timeout", "resignation", "stalemate", "draw by agreement", etc.
  timeControl: { type: String }, // "1", "3", "5", "10"
  moves:       [String],         // array of SAN moves e.g. ["e4", "e5", "Nf3", ...]
  pgn:         { type: String }, // full PGN string
  finalFen:    { type: String },
  playedAt:    { type: Date, default: Date.now },
});

gameSchema.index({ "white.userId": 1, playedAt: -1 });
gameSchema.index({ "black.userId": 1, playedAt: -1 });

module.exports = mongoose.model("Game", gameSchema);
