/**
 * WhatsApp SaaS Gateway — server.js
 * ===================================
 * Multi-tenant · Multi-number per client · Round-robin + Failover
 * هيكل: كل شركة عندها أرقام متعددة، الرسائل بتتوزع round-robin،
 * لو رقم انقطع بينتقل تلقائي لرقم ثاني وبيرسل إشعار webhook للشركة.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const express   = require('express');
const cors      = require('cors');
const qrcode    = require('qrcode');
const path      = require('path');
const fs        = require('fs');
const { spawnSync } = require('child_process');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;

// ─── DB Setup ────────────────────────────────────────────────────────────────
const db = new Database('./saas.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    api_key       TEXT UNIQUE NOT NULL,
    plan          TEXT NOT NULL DEFAULT 'starter',
    monthly_limit INTEGER NOT NULL DEFAULT 500,
    webhook_url   TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS numbers (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    label         TEXT,
    status        TEXT NOT NULL DEFAULT 'disconnected',
    rr_index      INTEGER NOT NULL DEFAULT 0,
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at  TEXT,
    UNIQUE(client_id, id)
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT NOT NULL,
    number_id     TEXT NOT NULL,
    phone_to      TEXT NOT NULL,
    status        TEXT NOT NULL,
    error_msg     TEXT,
    sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// ─── Chromium Detection ───────────────────────────────────────────────────────
function findChromium() {
  const candidates = [
    '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
const CHROMIUM_PATH = findChromium();

const BASE_PUPPETEER = {
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
    '--no-first-run', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--disable-default-apps',
    '--disable-sync', '--metrics-recording-only', '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--disable-blink-features=AutomationControlled'
  ],
  ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {})
};

// ─── Session Manager ─────────────────────────────────────────────────────────
/**
 * sessions: Map<numberId, SessionObj>
 * SessionObj: { client, status, qrData, retries, clientId }
 */
const sessions = new Map();

function makeSessionId(clientId, numberId) {
  return `client_${clientId}_num_${numberId}`;
}

function cleanLockFiles(sessionId) {
  const authDir = path.join(__dirname, '.wwebjs_auth', sessionId);
  if (!fs.existsSync(authDir)) return;
  try {
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
      spawnSync('find', [authDir, '-name', f, '-delete'], { stdio: 'ignore', timeout: 3000 });
    });
  } catch {}
}

async function createSession(clientId, numberId) {
  const sessionId = makeSessionId(clientId, numberId);

  // إذا في جلسة شغّالة بالفعل
  if (sessions.has(numberId)) {
    const existing = sessions.get(numberId);
    if (existing.status === 'connected') return;
    // لو في محاولة سابقة فاشلة، نتأكد إننا نوقفها أولاً
    try { await existing.client.destroy(); } catch {}
  }

  const session = {
    client: null,
    status: 'initializing',
    qrData: null,
    retries: 0,
    clientId,
    numberId,
    sessionId,
  };
  sessions.set(numberId, session);
  updateNumberStatus(numberId, 'initializing');

  cleanLockFiles(sessionId);

  const waClient = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: './.wwebjs_auth' }),
    puppeteer: BASE_PUPPETEER,
  });

  session.client = waClient;

  waClient.on('qr', async (qr) => {
    console.log(`[${sessionId}] QR received`);
    session.status   = 'waiting_qr';
    session.qrData   = await qrcode.toDataURL(qr).catch(() => null);
    session.retries  = 0;
    updateNumberStatus(numberId, 'waiting_qr');
  });

  waClient.on('authenticated', () => {
    console.log(`[${sessionId}] Authenticated`);
    session.status  = 'authenticated';
    session.qrData  = null;
    updateNumberStatus(numberId, 'authenticated');
  });

  waClient.on('ready', () => {
    console.log(`[${sessionId}] Ready`);
    session.status  = 'connected';
    session.qrData  = null;
    session.retries = 0;
    updateNumberStatus(numberId, 'connected');
    notifyClientWebhook(clientId, { event: 'number_connected', numberId });
  });

  waClient.on('disconnected', (reason) => {
    console.log(`[${sessionId}] Disconnected: ${reason}`);
    session.status = 'disconnected';
    session.qrData = null;
    updateNumberStatus(numberId, 'disconnected');
    notifyClientWebhook(clientId, { event: 'number_disconnected', numberId, reason });
    scheduleReconnect(clientId, numberId, 5000);
  });

  waClient.on('auth_failure', () => {
    console.log(`[${sessionId}] Auth failure`);
    session.status = 'auth_failed';
    updateNumberStatus(numberId, 'auth_failed');
    scheduleReconnect(clientId, numberId, 15000);
  });

  waClient.initialize().catch(err => {
    console.error(`[${sessionId}] Init error: ${err.message}`);
    session.status = 'error';
    updateNumberStatus(numberId, 'error');
    scheduleReconnect(clientId, numberId, 10000);
  });
}

function scheduleReconnect(clientId, numberId, delay) {
  const session = sessions.get(numberId);
  if (!session) return;
  const MAX_RETRIES = 5;
  if (session.retries >= MAX_RETRIES) {
    console.error(`[${numberId}] Max retries reached.`);
    session.status = 'failed';
    updateNumberStatus(numberId, 'failed');
    notifyClientWebhook(clientId, { event: 'number_failed', numberId });
    return;
  }
  session.retries++;
  const backoff = Math.min(delay * session.retries, 120000);
  console.log(`[${numberId}] Reconnect in ${backoff / 1000}s (attempt ${session.retries})`);
  setTimeout(() => {
    cleanLockFiles(makeSessionId(clientId, numberId));
    createSession(clientId, numberId).catch(console.error);
  }, backoff);
}

function updateNumberStatus(numberId, status) {
  try {
    db.prepare(`UPDATE numbers SET status = ? WHERE id = ?`).run(status, numberId);
  } catch {}
}

// ─── Webhook Notifier ─────────────────────────────────────────────────────────
async function notifyClientWebhook(clientId, payload) {
  try {
    const client = db.prepare(`SELECT webhook_url FROM clients WHERE id = ?`).get(clientId);
    if (!client?.webhook_url) return;
    await fetch(client.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, clientId, timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

// ─── Round-Robin + Failover Sender ────────────────────────────────────────────
/**
 * بيختار أفضل رقم متاح للشركة بطريقة round-robin
 * لو الرقم المختار منقطع بيحاول الثاني تلقائياً (failover)
 */
async function sendWithFailover(clientId, phone, message) {
  // جيب كل أرقام الشركة مرتبة حسب rr_index
  const numbers = db.prepare(`
    SELECT * FROM numbers WHERE client_id = ? ORDER BY rr_index ASC
  `).all(clientId);

  if (!numbers.length) {
    throw new Error('لا يوجد أرقام مضافة لهذه الشركة');
  }

  const connectedNumbers = numbers.filter(n =>
    sessions.get(n.id)?.status === 'connected'
  );

  if (!connectedNumbers.length) {
    throw new Error('جميع الأرقام غير متصلة حالياً');
  }

  // Round-robin: اختار الرقم الأقل استخداماً (أدنى rr_index)
  const chosen = connectedNumbers[0];
  const session = sessions.get(chosen.id);

  try {
    const cleaned = phone.toString().replace(/[^0-9]/g, '');
    let chatId;
    try {
      const numberId = await session.client.getNumberId(cleaned);
      chatId = numberId ? numberId._serialized : `${cleaned}@c.us`;
    } catch {
      chatId = `${cleaned}@c.us`;
    }

    await session.client.sendMessage(chatId, message);

    // تحديث round-robin: ارفع الـ index بـ 1 (الدورة الجاية رقم ثاني)
    db.prepare(`
      UPDATE numbers SET rr_index = rr_index + 1, last_used_at = datetime('now') WHERE id = ?
    `).run(chosen.id);

    // إعادة ضبط الـ index دورياً (بعد ما يوصل عدد الأرقام × 1000)
    const maxIdx = connectedNumbers.length * 1000;
    if (chosen.rr_index > maxIdx) {
      db.prepare(`UPDATE numbers SET rr_index = 0 WHERE client_id = ?`).run(clientId);
    }

    logUsage(clientId, chosen.id, phone, 'success');
    return { success: true, usedNumber: chosen.id, label: chosen.label };

  } catch (err) {
    logUsage(clientId, chosen.id, phone, 'error', err.message);

    // Failover: جرب رقم ثاني
    if (connectedNumbers.length > 1) {
      const fallback = connectedNumbers[1];
      const fallbackSession = sessions.get(fallback.id);
      try {
        const cleaned = phone.toString().replace(/[^0-9]/g, '');
        let chatId;
        try {
          const numberId = await fallbackSession.client.getNumberId(cleaned);
          chatId = numberId ? numberId._serialized : `${cleaned}@c.us`;
        } catch {
          chatId = `${cleaned}@c.us`;
        }
        await fallbackSession.client.sendMessage(chatId, message);
        db.prepare(`UPDATE numbers SET rr_index = rr_index + 1, last_used_at = datetime('now') WHERE id = ?`).run(fallback.id);
        logUsage(clientId, fallback.id, phone, 'success_failover');
        notifyClientWebhook(clientId, {
          event: 'failover_used',
          primaryNumber: chosen.id,
          fallbackNumber: fallback.id,
          reason: err.message,
        });
        return { success: true, usedNumber: fallback.id, label: fallback.label, failover: true };
      } catch (fallbackErr) {
        logUsage(clientId, fallback.id, phone, 'error', fallbackErr.message);
        throw new Error(`فشل الإرسال من جميع الأرقام. الأخطاء: ${err.message} / ${fallbackErr.message}`);
      }
    }

    throw err;
  }
}

function logUsage(clientId, numberId, phoneTo, status, errorMsg = null) {
  try {
    db.prepare(`
      INSERT INTO usage_log (client_id, number_id, phone_to, status, error_msg)
      VALUES (?, ?, ?, ?, ?)
    `).run(clientId, numberId, phoneTo, status, errorMsg);
  } catch {}
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ success: false, error: 'API key مطلوب' });

  const client = db.prepare(`SELECT * FROM clients WHERE api_key = ? AND is_active = 1`).get(key);
  if (!client) return res.status(401).json({ success: false, error: 'API key غير صالح' });

  req.waClient = client;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ success: false, error: 'غير مصرح' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateApiKey() {
  return 'wsa_' + crypto.randomBytes(24).toString('hex');
}
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Routes: Public API (للشركات العملاء) ────────────────────────────────────

// فحص الحالة
app.get('/api/status', requireApiKey, (req, res) => {
  const numbers = db.prepare(`SELECT * FROM numbers WHERE client_id = ?`).all(req.waClient.id);
  const enriched = numbers.map(n => ({
    ...n,
    sessionStatus: sessions.get(n.id)?.status || 'no_session',
    hasQR: !!(sessions.get(n.id)?.qrData),
  }));
  res.json({ success: true, client: req.waClient.name, numbers: enriched });
});

// جيب QR لرقم معين
app.get('/api/qr/:numberId', requireApiKey, (req, res) => {
  const { numberId } = req.params;
  const num = db.prepare(`SELECT * FROM numbers WHERE id = ? AND client_id = ?`)
    .get(numberId, req.waClient.id);
  if (!num) return res.status(404).json({ success: false, error: 'الرقم غير موجود' });

  const session = sessions.get(numberId);
  if (!session) return res.json({ message: 'الجلسة لم تبدأ بعد' });
  if (session.status === 'connected') return res.json({ message: 'الرقم متصل بالفعل' });
  if (session.qrData) return res.json({ qr: session.qrData });
  res.json({ message: 'انتظر... جاري تحضير QR', status: session.status });
});

// إرسال رسالة — بيستخدم round-robin + failover تلقائياً
app.post('/api/send', requireApiKey, async (req, res) => {
  const { phone, message, numberId } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone و message مطلوبان' });
  }

  // فحص الحد الشهري
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const usageCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM usage_log
    WHERE client_id = ? AND status LIKE 'success%'
    AND sent_at >= datetime(?)
  `).get(req.waClient.id, monthStart.toISOString());

  if (usageCount.cnt >= req.waClient.monthly_limit) {
    return res.status(429).json({
      success: false,
      error: `تجاوزت الحد الشهري (${req.waClient.monthly_limit} رسالة)`,
      used: usageCount.cnt,
      limit: req.waClient.monthly_limit,
    });
  }

  try {
    let result;
    if (numberId) {
      // الشركة اختارت رقم معين يدوياً
      const num = db.prepare(`SELECT * FROM numbers WHERE id = ? AND client_id = ?`)
        .get(numberId, req.waClient.id);
      if (!num) return res.status(404).json({ success: false, error: 'الرقم غير موجود' });

      const session = sessions.get(numberId);
      if (!session || session.status !== 'connected') {
        return res.status(503).json({ success: false, error: 'الرقم المحدد غير متصل' });
      }

      const cleaned = phone.toString().replace(/[^0-9]/g, '');
      let chatId;
      try {
        const nid = await session.client.getNumberId(cleaned);
        chatId = nid ? nid._serialized : `${cleaned}@c.us`;
      } catch { chatId = `${cleaned}@c.us`; }

      await session.client.sendMessage(chatId, message);
      db.prepare(`UPDATE numbers SET rr_index = rr_index + 1, last_used_at = datetime('now') WHERE id = ?`).run(numberId);
      logUsage(req.waClient.id, numberId, phone, 'success');
      result = { success: true, usedNumber: numberId, label: num.label };
    } else {
      // round-robin + failover تلقائي
      result = await sendWithFailover(req.waClient.id, phone, message);
    }

    res.json({
      ...result,
      remainingMessages: req.waClient.monthly_limit - usageCount.cnt - 1,
    });
  } catch (err) {
    console.error(`Send error [${req.waClient.id}]:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// إرسال bulk (قائمة أرقام)
app.post('/api/send/bulk', requireApiKey, async (req, res) => {
  const { targets, message } = req.body; // targets: [{phone, message?}]
  if (!targets?.length || !message) {
    return res.status(400).json({ success: false, error: 'targets[] و message مطلوبان' });
  }
  if (targets.length > 100) {
    return res.status(400).json({ success: false, error: 'الحد الأقصى 100 رسالة في الطلب الواحد' });
  }

  const results = [];
  for (const target of targets) {
    try {
      const r = await sendWithFailover(req.waClient.id, target.phone, target.message || message);
      results.push({ phone: target.phone, ...r });
    } catch (err) {
      results.push({ phone: target.phone, success: false, error: err.message });
    }
    // تأخير بسيط بين الرسائل لتجنب الحظر
    await new Promise(r => setTimeout(r, 1000));
  }

  res.json({ success: true, results });
});

// إحصائيات الاستخدام
app.get('/api/usage', requireApiKey, (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status LIKE 'success%' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status LIKE 'error%'   THEN 1 ELSE 0 END) as failed
    FROM usage_log WHERE client_id = ? AND sent_at >= datetime(?)
  `).get(req.waClient.id, monthStart.toISOString());

  const perNumber = db.prepare(`
    SELECT number_id, COUNT(*) as count, status
    FROM usage_log WHERE client_id = ? AND sent_at >= datetime(?)
    GROUP BY number_id, status
  `).all(req.waClient.id, monthStart.toISOString());

  res.json({
    success: true,
    plan: req.waClient.plan,
    monthlyLimit: req.waClient.monthly_limit,
    thisMonth: stats,
    perNumber,
  });
});

// ─── Routes: Admin (إدارة) ────────────────────────────────────────────────────

// إنشاء عميل جديد
app.post('/admin/clients', requireAdmin, (req, res) => {
  const { name, email, plan, monthlyLimit, webhookUrl } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, error: 'name و email مطلوبان' });

  const limits = { starter: 500, pro: 5000, enterprise: 999999 };
  const id     = generateId();
  const apiKey = generateApiKey();
  const limit  = monthlyLimit || limits[plan] || 500;

  try {
    db.prepare(`
      INSERT INTO clients (id, name, email, api_key, plan, monthly_limit, webhook_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, email, apiKey, plan || 'starter', limit, webhookUrl || null);

    res.json({ success: true, clientId: id, apiKey, plan: plan || 'starter', monthlyLimit: limit });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'البريد الإلكتروني مستخدم بالفعل' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب كل العملاء
app.get('/admin/clients', requireAdmin, (req, res) => {
  const clients = db.prepare(`SELECT * FROM clients ORDER BY created_at DESC`).all();
  const enriched = clients.map(c => {
    const numbers = db.prepare(`SELECT * FROM numbers WHERE client_id = ?`).all(c.id);
    return {
      ...c,
      api_key: c.api_key.slice(0, 12) + '...',
      numbers: numbers.map(n => ({
        ...n,
        status: sessions.get(n.id)?.status || n.status,
      })),
    };
  });
  res.json({ success: true, clients: enriched });
});

// تحديث بيانات عميل
app.put('/admin/clients/:id', requireAdmin, (req, res) => {
  const { plan, monthlyLimit, webhookUrl, isActive } = req.body;
  db.prepare(`
    UPDATE clients SET plan = COALESCE(?, plan),
    monthly_limit = COALESCE(?, monthly_limit),
    webhook_url = COALESCE(?, webhook_url),
    is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(plan, monthlyLimit, webhookUrl, isActive, req.params.id);
  res.json({ success: true });
});

// حذف عميل
app.delete('/admin/clients/:id', requireAdmin, async (req, res) => {
  const numbers = db.prepare(`SELECT * FROM numbers WHERE client_id = ?`).all(req.params.id);
  for (const num of numbers) {
    const session = sessions.get(num.id);
    if (session) {
      try { await session.client.destroy(); } catch {}
      sessions.delete(num.id);
    }
  }
  db.prepare(`DELETE FROM clients WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ─── Routes: Numbers Management ───────────────────────────────────────────────

// إضافة رقم جديد لعميل (من الأدمن أو الشركة بنفسها)
app.post('/api/numbers', requireApiKey, (req, res) => {
  const { label } = req.body;
  const id = generateId();

  try {
    db.prepare(`INSERT INTO numbers (id, client_id, label) VALUES (?, ?, ?)`)
      .run(id, req.waClient.id, label || `رقم ${id.slice(0, 4)}`);

    // ابدأ الجلسة تلقائياً
    createSession(req.waClient.id, id).catch(console.error);

    res.json({ success: true, numberId: id, message: 'جاري تحضير QR Code...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// إضافة رقم لعميل من الأدمن
app.post('/admin/clients/:clientId/numbers', requireAdmin, (req, res) => {
  const { label } = req.body;
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(req.params.clientId);
  if (!client) return res.status(404).json({ success: false, error: 'العميل غير موجود' });

  const id = generateId();
  db.prepare(`INSERT INTO numbers (id, client_id, label) VALUES (?, ?, ?)`)
    .run(id, req.params.clientId, label || `رقم ${id.slice(0, 4)}`);

  createSession(req.params.clientId, id).catch(console.error);
  res.json({ success: true, numberId: id });
});

// حذف رقم
app.delete('/api/numbers/:numberId', requireApiKey, async (req, res) => {
  const { numberId } = req.params;
  const num = db.prepare(`SELECT * FROM numbers WHERE id = ? AND client_id = ?`)
    .get(numberId, req.waClient.id);
  if (!num) return res.status(404).json({ success: false, error: 'الرقم غير موجود' });

  const session = sessions.get(numberId);
  if (session) {
    try { await session.client.logout(); } catch {}
    try { await session.client.destroy(); } catch {}
    sessions.delete(numberId);

    const authDir = path.join(__dirname, '.wwebjs_auth', makeSessionId(req.waClient.id, numberId));
    spawnSync('rm', ['-rf', authDir], { stdio: 'ignore', timeout: 5000 });
  }

  db.prepare(`DELETE FROM numbers WHERE id = ?`).run(numberId);
  res.json({ success: true, message: 'تم حذف الرقم وإلغاء الجلسة' });
});

// قطع رقم وإعادة ربطه (logout + new QR)
app.post('/api/numbers/:numberId/reconnect', requireApiKey, async (req, res) => {
  const { numberId } = req.params;
  const num = db.prepare(`SELECT * FROM numbers WHERE id = ? AND client_id = ?`)
    .get(numberId, req.waClient.id);
  if (!num) return res.status(404).json({ success: false, error: 'الرقم غير موجود' });

  const session = sessions.get(numberId);
  if (session) {
    try { await session.client.logout(); } catch {}
    try { await session.client.destroy(); } catch {}
    sessions.delete(numberId);
  }

  const authDir = path.join(__dirname, '.wwebjs_auth', makeSessionId(req.waClient.id, numberId));
  spawnSync('rm', ['-rf', authDir], { stdio: 'ignore', timeout: 5000 });

  setTimeout(() => createSession(req.waClient.id, numberId).catch(console.error), 1500);
  res.json({ success: true, message: 'جاري إعادة التهيئة، انتظر QR جديد' });
});

// ─── Startup: Resume Existing Sessions ───────────────────────────────────────
async function resumeSessions() {
  const numbers = db.prepare(`
    SELECT n.*, c.id as clientId FROM numbers n
    JOIN clients c ON c.id = n.client_id
    WHERE c.is_active = 1
  `).all();

  console.log(`\nاستئناف ${numbers.length} جلسة...`);
  for (const num of numbers) {
    await createSession(num.clientId, num.id).catch(err =>
      console.error(`[${num.id}] Resume error: ${err.message}`)
    );
    // تأخير بين كل جلسة لتجنب ضغط الذاكرة
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 WhatsApp SaaS Gateway`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Chromium: ${CHROMIUM_PATH || 'puppeteer default'}`);
  console.log(`   Admin   : ADMIN_TOKEN env required\n`);
  await resumeSessions();
});
