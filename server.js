/**
 * EngineTask — WhatsApp Notification Bot
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const admin    = require('firebase-admin');
const cron     = require('node-cron');
const express  = require('express');
const glob     = require('glob');

// ─── Firebase Admin Init ─────────────────────────────────────────
const serviceAccount = require('/etc/secrets/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── Express ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());
let botReady = false;
app.get('/status', (req, res) => res.json({ ready: botReady, uptime: process.uptime() }));
app.get('/ping',   (req, res) => res.send('pong'));
app.listen(process.env.PORT || 3001, () => {
  console.log(`[SERVER] Port ${process.env.PORT || 3001}`);
});

// ─── Find Chrome ─────────────────────────────────────────────────
function findChrome() {
  try {
    const puppeteer = require('puppeteer');
    const path = puppeteer.executablePath();
    console.log('[CHROME] Found:', path);
    return path;
  } catch(e) {
    console.log('[CHROME] Fallback to glob');
    const matches = glob.sync('/opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome');
    if (matches.length) { console.log('[CHROME]', matches[0]); return matches[0]; }
    return undefined;
  }
}

// ─── WhatsApp Client ─────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: findChrome(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ]
  }
});

client.on('qr', qr => {
  console.log('\n[QR] Scan with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('[WA] Authenticated ✓'));
client.on('ready', () => {
  console.log('[WA] Ready ✓');
  botReady = true;
  startFirestoreListener();
  startReminderCron();
});
client.on('disconnected', reason => {
  console.log('[WA] Disconnected:', reason);
  botReady = false;
  setTimeout(() => client.initialize(), 5000);
});
client.initialize();

// ─── Message Templates ────────────────────────────────────────────
function buildAssignMessage(task) {
  const emoji = { low:'🔵', medium:'🟡', high:'🟠', critical:'🔴' }[task.priority] || '⚪';
  return `🔧 *New Task Assigned*
━━━━━━━━━━━━━━━━━━━━
*Task:* ${task.title}
*Client:* ${task.client}
*Location:* ${task.location}
*Priority:* ${emoji} ${task.priority.toUpperCase()}
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

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-MY', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

// ─── Send WA ─────────────────────────────────────────────────────
async function sendWA(phone, message) {
  try {
    await client.sendMessage(`${phone}@c.us`, message);
    console.log(`[WA] ✓ Sent to ${phone}`);
    return true;
  } catch (err) {
    console.error(`[WA] ✗ Failed ${phone}:`, err.message);
    return false;
  }
}

// ─── Firestore Listener ───────────────────────────────────────────
function startFirestoreListener() {
  console.log('[LISTENER] Watching for new tasks…');
  db.collection('schedule-instrument')
    .where('notified', '==', false)
    .onSnapshot(async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const task = { id: change.doc.id, ...change.doc.data() };
          if (!task.engineerPhone) continue;
          console.log(`[TASK] "${task.title}" → ${task.engineerPhone}`);
          const sent = await sendWA(task.engineerPhone, buildAssignMessage(task));
          await db.collection('schedule-instrument').doc(task.id).update({
            notified: true,
            notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            notifySuccess: sent
          });
        }
      }
    }, err => console.error('[LISTENER]', err.message));
}

// ─── Daily Reminder Cron (8 AM KL time) ──────────────────────────
function startReminderCron() {
  cron.schedule('0 8 * * *', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tStr = tomorrow.toISOString().split('T')[0];
    console.log('[CRON] Checking reminders for', tStr);
    try {
      const snap = await db.collection('schedule-instrument')
        .where('deadline', '==', tStr)
        .where('status', '!=', 'completed')
        .where('reminderSent', '==', false)
        .get();
      console.log(`[CRON] ${snap.size} tasks due tomorrow`);
      for (const doc of snap.docs) {
        const task = { id: doc.id, ...doc.data() };
        if (!task.engineerPhone) continue;
        const sent = await sendWA(task.engineerPhone, buildReminderMessage(task));
        await doc.ref.update({
          reminderSent: true,
          reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          reminderSuccess: sent
        });
        console.log(`[CRON] Reminder sent → ${task.engineerName}`);
      }
    } catch (err) { console.error('[CRON]', err.message); }
  }, { timezone: 'Asia/Kuala_Lumpur' });
  console.log('[CRON] Reminder set: 08:00 KL time');
}

// ─── Self-ping every 10 min (keeps Render awake) ─────────────────
setInterval(async () => {
  try { await fetch('https://enginetask-bot.onrender.com/ping'); } catch {}
}, 10 * 60 * 1000);
