/**
 * EngineTask — WhatsApp Notification Bot
 * ───────────────────────────────────────
 * Uses whatsapp-web.js to send task assignments + reminders
 * via YOUR WhatsApp account (scan QR once, stays connected).
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const admin    = require('firebase-admin');
const cron     = require('node-cron');
const express  = require('express');

// ─── Firebase Admin Init ─────────────────────────────────────────
const serviceAccount = require('/etc/secrets/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── Express (status endpoint + keep-alive) ──────────────────────
const app = express();
app.use(express.json());

let botReady = false;

app.get('/status', (req, res) => {
  res.json({ ready: botReady, uptime: process.uptime() });
});

// Self-ping endpoint to keep Render.com free tier awake
app.get('/ping', (req, res) => res.send('pong'));

app.listen(process.env.PORT || 3001, () => {
  console.log(`[SERVER] Running on port ${process.env.PORT || 3001}`);
});

// ─── WhatsApp Client ─────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),   // saves session locally — no re-scan needed
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  console.log('\n[QR] Scan this with your WhatsApp:\n');
  qrcode.generate(qr, { small: true });
  console.log('\n');
});

client.on('authenticated', () => {
  console.log('[WA] Authenticated ✓');
});

client.on('ready', () => {
  console.log('[WA] Client ready ✓');
  botReady = true;
  startFirestoreListener();
  startReminderCron();
});

client.on('disconnected', reason => {
  console.log('[WA] Disconnected:', reason);
  botReady = false;
  // Auto-reconnect
  setTimeout(() => client.initialize(), 5000);
});

client.initialize();

// ─── Message Templates ────────────────────────────────────────────
function buildAssignMessage(task) {
  const priorityEmoji = {
    low: '🔵', medium: '🟡', high: '🟠', critical: '🔴'
  }[task.priority] || '⚪';

  return `🔧 *New Task Assigned*
━━━━━━━━━━━━━━━━━━━━
*Task:* ${task.title}
*Client:* ${task.client}
*Location:* ${task.location}
*Priority:* ${priorityEmoji} ${task.priority.toUpperCase()}
*Deadline:* ${formatDate(task.deadline)}
━━━━━━━━━━━━━━━━━━━━
*Details:*
${task.description || 'No additional details.'}

_Please acknowledge by replying ✅_`;
}

function buildReminderMessage(task) {
  return `⏰ *Task Reminder — Due Tomorrow!*
━━━━━━━━━━━━━━━━━━━━
*Task:* ${task.title}
*Client:* ${task.client}
*Location:* ${task.location}
*Deadline:* ${formatDate(task.deadline)}
━━━━━━━━━━━━━━━━━━━━
Please ensure this is completed on time.

_EngineTask System_`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-MY', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

// ─── Send WhatsApp Message ────────────────────────────────────────
async function sendWA(phone, message) {
  try {
    const chatId = `${phone}@c.us`;
    await client.sendMessage(chatId, message);
    console.log(`[WA] ✓ Sent to ${phone}`);
    return true;
  } catch (err) {
    console.error(`[WA] ✗ Failed to send to ${phone}:`, err.message);
    return false;
  }
}

// ─── Firestore Listener: New Tasks ───────────────────────────────
// Watches for tasks where notified == false and sends WA immediately
function startFirestoreListener() {
  console.log('[LISTENER] Watching Firestore for new tasks…');

  db.collection('schedule-instrument')
    .where('notified', '==', false)
    .onSnapshot(async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const task = { id: change.doc.id, ...change.doc.data() };
          console.log(`[TASK] New/updated task: "${task.title}" → ${task.engineerPhone}`);

          if (!task.engineerPhone) continue;

          const message = buildAssignMessage(task);
          const sent = await sendWA(task.engineerPhone, message);

          // Mark as notified regardless (prevent retry loop)
          await db.collection('schedule-instrument').doc(task.id).update({
            notified: true,
            notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            notifySuccess: sent
          });
        }
      }
    }, err => {
      console.error('[LISTENER] Error:', err.message);
    });
}

// ─── Cron: Daily Reminder (8:00 AM) ──────────────────────────────
// Checks for tasks with deadline = tomorrow and sends reminder
function startReminderCron() {
  // Runs every day at 8:00 AM (server time — set your Render timezone to Asia/Kuala_Lumpur)
  cron.schedule('0 8 * * *', async () => {
    console.log('[CRON] Running daily reminder check…');

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

    try {
      const snap = await db.collection('schedule-instrument')
        .where('deadline', '==', tomorrowStr)
        .where('status', '!=', 'completed')
        .where('reminderSent', '==', false)
        .get();

      console.log(`[CRON] Found ${snap.size} tasks due tomorrow`);

      for (const doc of snap.docs) {
        const task = { id: doc.id, ...doc.data() };
        if (!task.engineerPhone) continue;

        const message = buildReminderMessage(task);
        const sent = await sendWA(task.engineerPhone, message);

        await doc.ref.update({
          reminderSent: true,
          reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          reminderSuccess: sent
        });

        console.log(`[CRON] Reminder sent for "${task.title}" to ${task.engineerName}`);
      }
    } catch (err) {
      console.error('[CRON] Error:', err.message);
    }
  }, {
    timezone: 'Asia/Kuala_Lumpur' // ← adjust if not Malaysia
  });

  console.log('[CRON] Daily reminder scheduled at 08:00 Asia/KL');
}

// ─── Self-ping to prevent Render.com sleep ───────────────────────
if (process.env.RENDER_EXTERNAL_URL || true) {
  const pingUrl = process.env.RENDER_EXTERNAL_URL || 'https://enginetask-bot.onrender.com';
  setInterval(async () => {
    try { await fetch(`${pingUrl}/ping`); } catch {}
  }, 10 * 60 * 1000);
}
