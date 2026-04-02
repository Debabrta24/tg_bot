require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const express = require("express")
const app = express()

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

//   ERROR SAFE  
bot.catch(console.error);
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

//   DB  
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

//   STATE  
let adminState = {};
let broadcastMode = false;

//   START  
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  if (userId) {
    await User.updateOne({ userId }, { userId }, { upsert: true });
  }

  // ADMIN PANEL
  if (userId === ADMIN_ID) {
    return ctx.reply(
      "👑 ADMIN PANEL",
      {
        ...Markup.removeKeyboard(),
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Add Coupon", "add_coupon")],
          [Markup.button.callback("📦 View Coupons", "view_coupon")],
          [Markup.button.callback("✏️ Edit Coupon", "edit_coupon")],
          [Markup.button.callback("❌ Delete Coupon", "delete_coupon")],
          [Markup.button.callback("📢 Broadcast", "broadcast")],
        ]),
      }
    );
  }

  // USER PANEL
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

//   TEXT HANDLER  
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // BROADCAST
  if (userId === ADMIN_ID && broadcastMode) {
    const users = await User.find();

    for (let u of users) {
      if (!u.userId) continue;
      try {
        await bot.telegram.sendMessage(u.userId, ctx.message.text);
      } catch { }
    }

    broadcastMode = false;
    return ctx.reply("✅ Broadcast Sent");
  }

  // ADMIN ADD / EDIT
  if (userId === ADMIN_ID && adminState[userId]) {
    let state = adminState[userId];

    // ADD
    if (state.mode === "add") {
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
        return ctx.reply("Enter Codes:");
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

    // EDIT
    if (state.mode === "edit_value") {
      const coupon = await Coupon.findById(state.couponId);

      if (state.field === "name") coupon.name = ctx.message.text;
      if (state.field === "price") coupon.price = parseInt(ctx.message.text);
      if (state.field === "stock") coupon.stock = parseInt(ctx.message.text);

      await coupon.save();
      delete adminState[userId];
      return ctx.reply("✅ Coupon Updated");
    }
  }

  // ADMIN REPLY
  if (userId === ADMIN_ID && ctx.message.reply_to_message) {
    const match = ctx.message.reply_to_message.text.match(/User ID: (\d+)/);
    if (!match) return;

    await bot.telegram.sendMessage(
      match[1],
      `💬 Admin Reply:\n\n${ctx.message.text}`
    );
    return;
  }

  // USER MESSAGE → ADMIN
  if (userId !== ADMIN_ID) {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📩 New Message\n\n👤 User ID: ${userId}\n💬 ${ctx.message.text}`
    );

    return ctx.reply("📨 Sent to admin");
  }
});

//   ADMIN BUTTONS  
bot.action("add_coupon", (ctx) => {
  adminState[ctx.from.id] = { mode: "add", step: "name" };
  ctx.reply("Enter Coupon Name:");
});

bot.action("view_coupon", async (ctx) => {
  const coupons = await Coupon.find();
  let text = coupons.map(c => `${c.name} | ₹${c.price} | Stock:${c.stock}`).join("\n");
  ctx.reply(text || "No coupons");
});

//   EDIT  
bot.action("edit_coupon", async (ctx) => {
  const coupons = await Coupon.find();

  let buttons = coupons.map(c => [
    Markup.button.callback(c.name, `edit_select_${c._id}`)
  ]);

  ctx.reply("Select coupon", Markup.inlineKeyboard(buttons));
});

bot.action(/edit_select_(.+)/, (ctx) => {
  const id = ctx.match[1];

  ctx.reply(
    "What to edit?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Name", `edit_field_name_${id}`)],
      [Markup.button.callback("Price", `edit_field_price_${id}`)],
      [Markup.button.callback("Stock", `edit_field_stock_${id}`)],
    ])
  );
});

bot.action(/edit_field_(.+)_(.+)/, (ctx) => {
  adminState[ctx.from.id] = {
    mode: "edit_value",
    field: ctx.match[1],
    couponId: ctx.match[2],
  };

  ctx.reply(`Enter new ${ctx.match[1]}`);
});

//   DELETE  
bot.action("delete_coupon", async (ctx) => {
  const coupons = await Coupon.find();

  let buttons = coupons.map(c => [
    Markup.button.callback(c.name, `delete_${c._id}`)
  ]);

  ctx.reply("Select coupon", Markup.inlineKeyboard(buttons));
});

bot.action(/delete_(.+)/, async (ctx) => {
  await Coupon.findByIdAndDelete(ctx.match[1]);
  ctx.reply("❌ Deleted");
});

//   BROADCAST  
bot.action("broadcast", (ctx) => {
  broadcastMode = true;
  ctx.reply("Send message:");
});

//   BUY → DISCLAIMER  
bot.action(/buy_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const coupon = await Coupon.findById(id);

  if (!coupon || coupon.stock <= 0) {
    return ctx.reply("❌ Out of stock");
  }

  ctx.reply(
    `⚠️ *Disclaimer*\n\n• This coupon is valid only for new accounts\n• No refund available\n• Buy at your own risk\n• All coupons are properly checked\n\nDo you agree?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ I Agree", `agree_${id}`),
          Markup.button.callback("❌ Disagree", "disagree"),
        ],
      ]),
    }
  );
});

//   AGREE  
bot.action(/agree_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const coupon = await Coupon.findById(id);

  const qr = await QRCode.toBuffer(
    `upi://pay?pa=debabrata17@fam&am=${coupon.price}`
  );

  await ctx.editMessageText("✅ Proceed to payment");

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

//   DISAGREE  
bot.action("disagree", (ctx) => {
  ctx.editMessageText("❌ Cancelled");
});

//   PAID  
bot.action(/paid_(.+)/, async (ctx) => {
  const coupon = await Coupon.findById(ctx.match[1]);

  try { await ctx.deleteMessage(); } catch { }

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `💰 Payment\n👤 User: ${ctx.from.id}\n🎟 ${coupon.name}\n₹${coupon.price}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Approve", `approve_${ctx.from.id}_${coupon._id}`),
        Markup.button.callback("Reject", `reject_${ctx.from.id}`)
      ]
    ])
  );

  ctx.reply("Waiting for approval...");
});

//   APPROVE  
bot.action(/approve_(.+)_(.+)/, async (ctx) => {
  const userId = ctx.match[1];
  const coupon = await Coupon.findById(ctx.match[2]);

  const code = coupon.codes.pop();
  coupon.stock -= 1;
  await coupon.save();

  await bot.telegram.sendMessage(userId, `🎟 Code: ${code}`);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

//   REJECT  
bot.action(/reject_(.+)/, async (ctx) => {
  await bot.telegram.sendMessage(ctx.match[1], "Rejected");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.launch();
console.log("🤖 Bot running...");

app.listen(3000, () => {
  console.log("server started")
})