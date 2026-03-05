/**
 * EngineTask — WhatsApp Notification Bot
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const admin    = require('firebase-admin');
const cron     = require('node-cron');
const express  = require('express');

// ─── Firebase ─────────────────────────────────────────────────────
// Works on laptop (./serviceAccountKey.json) AND Render (/etc/secrets/serviceAccountKey.json)
const serviceAccountPath = require('fs').existsSync('/etc/secrets/serviceAccountKey.json')
  ? '/etc/secrets/serviceAccountKey.json'
  : './serviceAccountKey.json';
const serviceAccount = require(serviceAccountPath);
console.log('[FIREBASE] Using key from:', serviceAccountPath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── Express ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
let botReady = false;
app.get('/status', (req, res) => res.json({ ready: botReady, uptime: process.uptime() }));
app.get('/ping',   (req, res) => res.send('pong'));
app.listen(process.env.PORT || 3001, () => console.log(`[SERVER] Port ${process.env.PORT || 3001}`));

// ─── WhatsApp Client ───────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  }
});

client.on('qr', qr => { console.log('\n[QR] Scan with WhatsApp:\n'); qrcode.generate(qr, { small: true }); });
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

// ─── Processing Queue (prevents multi-task interruption) ───────────
let isProcessing = false;
const sendQueue  = [];

async function processQueue() {
  if (isProcessing) return;  // already running, new items will be picked up
  isProcessing = true;
  console.log(`[QUEUE] Starting. ${sendQueue.length} task(s) to send.`);

  while (sendQueue.length > 0) {
    const task = sendQueue.shift();
    console.log(`[QUEUE] Processing: "${task.title}" → ${task.engineerName} (${sendQueue.length} remaining after this)`);

    // Mark immediately so snapshot doesn't re-add it
    await db.collection('schedule-instrument').doc(task.id).update({
      notified: true,
      notifiedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Get all engineers — support both new array format and legacy single engineer
    const engineers = (task.engineers && task.engineers.length)
      ? task.engineers
      : (task.engineerPhone ? [{ name: task.engineerName, phone: task.engineerPhone }] : []);

    console.log(`[QUEUE] Sending to ${engineers.length} engineer(s): ${engineers.map(e=>e.name).join(', ')}`);

    let allSent = true;
    for (let i = 0; i < engineers.length; i++) {
      const eng = engineers[i];
      if (!eng.phone) continue;
      if (i > 0) await randomDelay(); // delay between each engineer
      const sent = await sendWA(eng.phone, buildAssignMessage(task, eng));
      if (!sent) allSent = false;
      console.log(`[QUEUE] → ${eng.name}: ${sent ? '✓ Sent' : '✗ Failed'}`);
    }

    await db.collection('schedule-instrument').doc(task.id).update({
      notifySuccess: allSent,
      notifySentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[QUEUE] Done: "${task.title}" → ${allSent ? '✓ All sent' : '✗ Some failed'}`);
  }

  isProcessing = false;
  console.log('[QUEUE] All done.');
}

// ─── Delay Helper ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay() {
  const ms = Math.floor(Math.random() * 12000) + 8000; // 8–20 sec
  console.log(`[DELAY] Waiting ${(ms/1000).toFixed(1)}s before next message…`);
  return sleep(ms);
}

// ─── Message Templates ─────────────────────────────────────────────
function buildAssignMessage(task, eng) {
  // eng = specific engineer being messaged (for personalised greeting)
  const recipientName = eng ? eng.name : task.engineerName;
  const emoji = { low:'🔵', medium:'🟡', high:'🟠', critical:'🔴' }[task.priority] || '⚪';
  return `🔧 *New Task Assigned*
_Hi ${recipientName}!_
━━━━━━━━━━━━━━━━━━━━
*Task:* ${task.title}
*Client:* ${task.client}
*Location:* ${task.location}
*Priority:* ${emoji} ${task.priority.toUpperCase()}
*Deadline:* ${formatDate(task.deadline)}
*Going Together:* ${task.goingTogether || '-'}
━━━━━━━━━━━━━━━━━━━━
*Details:*
${task.description || 'No additional details.'}

_Please acknowledge by replying ✅_`;
}

function buildReminderMessage(task, eng) {
  const recipientName = eng ? eng.name : task.engineerName;
  return `⏰ *Task Reminder — Due Tomorrow!*
_Hi ${recipientName}!_
━━━━━━━━━━━━━━━━━━━━
*Task:* ${task.title}
*Client:* ${task.client}
*Location:* ${task.location}
*Deadline:* ${formatDate(task.deadline)}
*Going Together:* ${task.goingTogether || '-'}
━━━━━━━━━━━━━━━━━━━━
Please ensure this is completed on time.
_EngineTask System_`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-MY', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

// ─── Send WA ──────────────────────────────────────────────────────
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

// ─── Firestore Listener ────────────────────────────────────────────
// Watches for tasks where admin pressed "Send WA" (waSent:true, notified:false)
function startFirestoreListener() {
  console.log('[LISTENER] Watching for tasks to send…');

  db.collection('schedule-instrument')
    .where('notified', '==', false)
    .where('waSent', '==', true)
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const task = { id: change.doc.id, ...change.doc.data() };

          // Don't add duplicates to queue
          const alreadyQueued = sendQueue.find(t => t.id === task.id);
          if (!alreadyQueued) {
            console.log(`[LISTENER] Queued: "${task.title}" → ${task.engineerName}`);
            sendQueue.push(task);
          }
        }
      });

      // Start processing (safe to call even if already running)
      if (sendQueue.length > 0) {
        processQueue();
      }
    }, err => console.error('[LISTENER]', err.message));
}

// ─── Daily Reminder Cron (8 AM KL) ────────────────────────────────
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

      console.log(`[CRON] ${snap.size} reminders to send`);

      for (const doc of snap.docs) {
        const task = { id: doc.id, ...doc.data() };
        const remindEngineers = (task.engineers && task.engineers.length)
          ? task.engineers
          : (task.engineerPhone ? [{ name: task.engineerName, phone: task.engineerPhone }] : []);

        if (!remindEngineers.length) continue;

        for (let i = 0; i < remindEngineers.length; i++) {
          const eng = remindEngineers[i];
          if (!eng.phone) continue;
          if (i > 0) await randomDelay();
          await sendWA(eng.phone, buildReminderMessage(task, eng));
        }
        const sent = true;
        await doc.ref.update({
          reminderSent: true,
          reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          reminderSuccess: sent
        });
        console.log(`[CRON] Reminder → ${task.engineerName}: ${sent ? '✓' : '✗'}`);
      }
    } catch (err) { console.error('[CRON]', err.message); }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  console.log('[CRON] Reminder set: 08:00 KL time');
}

// ─── Self-ping every 10 min ────────────────────────────────────────
setInterval(async () => {
  try { await fetch('https://enginetask-bot.onrender.com/ping'); } catch {}
}, 10 * 60 * 1000);
