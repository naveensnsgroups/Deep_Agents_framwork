const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  total: { type: Number, required: true, min: 0 },
  // unique creates an index, not a validator — a classic migration trap
  reference: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Order", OrderSchema);
