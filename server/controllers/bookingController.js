import Booking from "../models/Booking.js"
import Car from "../models/Car.js";
import crypto from "crypto";
import { razorpay } from "../modules/razorpay.js";


// Function to Check Availability of Car for a given Date
const checkAvailability = async (car, pickupDate, returnDate)=>{
    const bookings = await Booking.find({
        car,
        pickupDate: {$lte: returnDate},
        returnDate: {$gte: pickupDate},
    })
    return bookings.length === 0;
}

// API to Check Availability of Cars for the given Date and location
export const checkAvailabilityOfCar = async (req, res)=>{
    try {
        const {location, pickupDate, returnDate} = req.body

        // fetch all available cars for the given location
        const cars = await Car.find({location, isAvaliable: true})

        // check car availability for the given date range using promise
        const availableCarsPromises = cars.map(async (car)=>{
           const isAvailable = await checkAvailability(car._id, pickupDate, returnDate)
           return {...car._doc, isAvailable: isAvailable}
        })

        let availableCars = await Promise.all(availableCarsPromises);
        availableCars = availableCars.filter(car => car.isAvailable === true)

        res.json({success: true, availableCars})

    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

// API to Create Booking

// helper: combine date + time to ISO
const toISO = (dateStr, timeStr = "10:00") => {
  if (!dateStr) return null;
  const t = timeStr && timeStr.length ? timeStr : "10:00";
  return new Date(`${dateStr}T${t}:00.000Z`).toISOString();
};

export const createBookingOrder = async (req, res) => {
  try {
    const { _id: userId, name, email, phone } = req.user || {};
    const {
      car,
      pickupDate,
      returnDate,
      pickupTime,      // NEW (optional)
      returnTime,      // NEW (optional)
      location,        // NEW (optional)
      address,         // NEW (optional)
    } = req.body;

    // Basic input checks
    if (!car || !pickupDate || !returnDate) {
      return res.json({ success: false, message: "car, pickupDate and returnDate are required." });
    }

    const pickupISO = toISO(pickupDate, pickupTime);
    const returnISO = toISO(returnDate, returnTime);

    if (!pickupISO || !returnISO) {
      return res.json({ success: false, message: "Invalid pickup/return date or time." });
    }
    if (new Date(returnISO) <= new Date(pickupISO)) {
      return res.json({ success: false, message: "Return must be after pickup." });
    }

    // Ensure car exists and is available
    const carData = await Car.findById(car);
    if (!carData) {
      return res.json({ success: false, message: "Car not found." });
    }
    if (carData.isAvaliable === false) {
      return res.json({ success: false, message: "Car is not available." });
    }

    // Check overlapping bookings (your existing util)
    const isAvailable = await checkAvailability(car, pickupDate, returnDate);
    if (!isAvailable) {
      return res.json({ success: false, message: "Car is not available for the selected dates." });
    }

    // Compute price (at least 1 day)
    const picked = new Date(pickupDate);
    const returned = new Date(returnDate);
    const noOfDays = Math.max(1, Math.ceil((returned - picked) / (1000 * 60 * 60 * 24)));
    const price = Number(carData.pricePerDay || 0) * noOfDays;

    if (!isFinite(price) || price <= 0) {
      return res.json({ success: false, message: "Invalid price computation for this car." });
    }

    // Create Razorpay order (amount in paise, integer)
    const amountPaise = Math.round(price * 100);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      notes: {
        car: String(car),
        user: String(userId || ""),
        pickupDate,
        returnDate,
        pickupTime: pickupTime || "",
        returnTime: returnTime || "",
        location: location || "",
        address: address || "",
      },
    });

    // Create pending booking with orderId
    // Store extra fields if your schema has them; also keep a 'details' object fallback.
    const booking = await Booking.create({
      car,
      owner: carData.owner,
      user: userId,
      pickupDate,
      returnDate,
      // if your schema has these, they'll be saved; otherwise they’ll be ignored harmlessly
      pickupTime: pickupTime || undefined,
      returnTime: returnTime || undefined,
      location: location || undefined,
      address: address || undefined,
      // safe fallback blob for projects that don't have individual fields yet
      details: {
        pickupTime: pickupTime || null,
        returnTime: returnTime || null,
        location: location || null,
        address: address || null,
      },
      price,
      status: "pending", // make sure your enum allows 'pending'
      payment: { orderId: order.id, status: "created" },
    });

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      order,
      bookingId: booking._id,
      prefill: { name: name || "", email: email || "", contact: phone || "" },
    });
  } catch (err) {
    console.error(err);
    return res.json({ success: false, message: err.message });
  }
};

/**
 * Verify payment signature after Checkout success.
 * Flow: client -> POST /api/payments/verify with ids + signature
 */
export const verifyBookingPayment = async (req, res) => {
  try {
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // 1) Validate signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // 2) Mark booking paid
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    booking.status = "confirmed";
    booking.payment = {
      ...booking.payment,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      status: "paid",
    };
    await booking.save();

    res.json({ success: true, message: "Payment verified", bookingId: booking._id });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message });
  }
};



// API to List User Bookings 
export const getUserBookings = async (req, res)=>{
    try {
        const {_id} = req.user;
        const bookings = await Booking.find({ user: _id }).populate("car").sort({createdAt: -1})
        res.json({success: true, bookings})

    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

// API to get Owner Bookings

export const getOwnerBookings = async (req, res)=>{
    try {
        if(req.user.role !== 'owner'){
            return res.json({ success: false, message: "Unauthorized" })
        }
        const bookings = await Booking.find({owner: req.user._id}).populate('car user').select("-user.password").sort({createdAt: -1 })
        res.json({success: true, bookings})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

// API to change booking status
export const changeBookingStatus = async (req, res)=>{
    try {
        const {_id} = req.user;
        const {bookingId, status} = req.body

        const booking = await Booking.findById(bookingId)

        if(booking.owner.toString() !== _id.toString()){
            return res.json({ success: false, message: "Unauthorized"})
        }

        booking.status = status;
        await booking.save();

        res.json({ success: true, message: "Status Updated"})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}