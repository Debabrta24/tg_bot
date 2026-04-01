require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const QRCode = require("qrcode");

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ===== GLOBAL ERROR HANDLER =====
bot.catch((err) => console.log("BOT ERROR:", err));
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

// ===== DB =====
mongoose.connect(process.env.MONGO_URI);

const userSchema = new mongoose.Schema({
  userId: Number,
});

const couponSchema = new mongoose.Schema({
  name: String,
  price: Number,
  stock: Number,
  codes: [String],
});

const User = mongoose.model("User", userSchema);
const Coupon = mongoose.model("Coupon", couponSchema);

// ===== STATE =====
let adminState = {};
let broadcastMode = false;

// ===== START =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // save user safely
  if (userId) {
    await User.updateOne(
      { userId },
      { userId },
      { upsert: true }
    );
  }

  // ===== ADMIN =====
  if (userId === ADMIN_ID) {
    return ctx.reply(
      "👑 ADMIN PANEL",
      {
        ...Markup.removeKeyboard(),
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Add Coupon", "add_coupon")],
          [Markup.button.callback("📦 View Coupons", "view_coupon")],
          [Markup.button.callback("📢 Broadcast", "broadcast")],
        ]),
      }
    );
  }

  // ===== USER =====
  const coupons = await Coupon.find();

  let buttons = coupons.map((c) => [
    Markup.button.callback(
      `${c.name} | ₹${c.price} | Stock:${c.stock}`,
      `buy_${c._id}`
    ),
  ]);

  return ctx.reply(
    "🛍 Available Coupons\n\n💬 Send message for support",
    {
      ...Markup.removeKeyboard(),
      ...Markup.inlineKeyboard(buttons),
    }
  );
});


// ===== TEXT HANDLER =====
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // ===== BROADCAST FIX =====
  if (userId === ADMIN_ID && broadcastMode) {
    const users = await User.find();

    for (let u of users) {
      if (!u.userId) continue;

      try {
        await bot.telegram.sendMessage(u.userId, ctx.message.text);
      } catch (err) {
        console.log("❌ Failed user:", u.userId);
      }
    }

    broadcastMode = false;
    return ctx.reply("✅ Broadcast Sent");
  }

  // ===== ADMIN ADD FLOW =====
  if (userId === ADMIN_ID && adminState[userId]) {
    let state = adminState[userId];

    if (state.step === "name") {
      state.name = ctx.message.text;
      state.step = "price";
      return ctx.reply("Enter Price:");
    }

    if (state.step === "price") {
      state.price = parseInt(ctx.message.text);
      state.step = "stock";
      return ctx.reply("Enter Stock:");
    }

    if (state.step === "stock") {
      state.stock = parseInt(ctx.message.text);
      state.step = "codes";
      return ctx.reply("Enter Codes (comma separated):");
    }

    if (state.step === "codes") {
      const codes = ctx.message.text.split(",");

      await Coupon.create({
        name: state.name,
        price: state.price,
        stock: state.stock,
        codes,
      });

      delete adminState[userId];
      return ctx.reply("✅ Coupon Added");
    }
  }

  // ===== ADMIN REPLY =====
  if (userId === ADMIN_ID && ctx.message.reply_to_message) {
    const text = ctx.message.reply_to_message.text;

    const match = text.match(/User ID: (\d+)/);

    if (!match) return ctx.reply("❌ Cannot find user");

    const targetUser = match[1];

    try {
      await bot.telegram.sendMessage(
        targetUser,
        `💬 Admin Reply:\n\n${ctx.message.text}`
      );
    } catch {
      ctx.reply("❌ Failed to send");
    }

    return;
  }

  // ===== USER → ADMIN =====
  if (userId !== ADMIN_ID) {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📩 New Message\n\n👤 User ID: ${userId}\n💬 ${ctx.message.text}`
    );

    return ctx.reply("📨 Message sent to admin");
  }
});


// ===== ADMIN BUTTONS =====
bot.action("add_coupon", (ctx) => {
  adminState[ctx.from.id] = { step: "name" };
  ctx.reply("Enter Coupon Name:");
});

bot.action("broadcast", (ctx) => {
  broadcastMode = true;
  ctx.reply("📢 Send message:");
});

bot.action("view_coupon", async (ctx) => {
  const coupons = await Coupon.find();

  let text = coupons
    .map((c) => `${c.name} | ₹${c.price} | Stock:${c.stock}`)
    .join("\n");

  ctx.reply(text || "No coupons");
});


// ===== BUY =====
bot.action(/buy_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const coupon = await Coupon.findById(id);

  if (!coupon || coupon.stock <= 0) {
    return ctx.reply("❌ Out of stock");
  }

  const qr = await QRCode.toBuffer(
    `upi://pay?pa=yourupi@upi&am=${coupon.price}`
  );

  ctx.replyWithPhoto(
    { source: qr },
    {
      caption: `💳 Pay ₹${coupon.price}`,
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ I Have Paid", `paid_${id}`)],
      ]),
    }
  );
});


// ===== PAID =====
bot.action(/paid_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const coupon = await Coupon.findById(id);

  try { await ctx.deleteMessage(); } catch {}

  const time = new Date().toLocaleString();

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `💰 Payment Request\n\n👤 User: ${ctx.from.id}\n🎟 Coupon: ${coupon.name}\n💰 ₹${coupon.price}\n🕒 ${time}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Approve",
          `approve_${ctx.from.id}_${id}`
        ),
        Markup.button.callback(
          "❌ Reject",
          `reject_${ctx.from.id}`
        ),
      ],
    ])
  );

  ctx.reply("⏳ Waiting for approval...");
});


// ===== APPROVE =====
bot.action(/approve_(.+)_(.+)/, async (ctx) => {
  const userId = ctx.match[1];
  const couponId = ctx.match[2];

  const coupon = await Coupon.findById(couponId);

  if (!coupon || coupon.stock <= 0) {
    return ctx.answerCbQuery("❌ No stock");
  }

  const code = coupon.codes.pop();
  coupon.stock -= 1;
  await coupon.save();

  await bot.telegram.sendMessage(
    userId,
    `🎉 Payment Approved!\n\n🎟 Code: ${code}`
  );

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});


// ===== REJECT =====
bot.action(/reject_(.+)/, async (ctx) => {
  const userId = ctx.match[1];

  await bot.telegram.sendMessage(userId, "❌ Payment Rejected");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});


// ===== RUN =====
bot.launch();
console.log("🤖 Bot running...");


const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running...");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));