import mongoose from "mongoose";
const { ObjectId } = mongoose.Schema.Types;

const bookingSchema = new mongoose.Schema(
  {
    car: { type: ObjectId, ref: "Car", required: true },
    user: { type: ObjectId, ref: "User", required: true },
    owner: { type: ObjectId, ref: "User", required: true },

    // Booking dates
    pickupDate: { type: Date, required: true },
    returnDate: { type: Date, required: true },

    // ✅ New fields
    pickupTime: { type: String },     // e.g., "10:00 AM"
    returnTime: { type: String },     // e.g., "06:00 PM"
    location: { type: String },       // e.g., "Mumbai Airport"
    address: { type: String },        // full address

    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled"],
      default: "pending",
    },
    price: { type: Number, required: true },

    payment: {
      orderId: String,
      paymentId: String,
      signature: String,
      method: String,
      status: { type: String, default: "created" }, // created | paid | failed
    },
  },
  { timestamps: true }
);

const Booking = mongoose.model("Booking", bookingSchema);

export default Booking;
