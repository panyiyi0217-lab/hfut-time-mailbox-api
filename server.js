const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const nodemailer = require("nodemailer");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "letters.sqlite");
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS || 60_000);
const MAX_SEND_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS || 5);
const MAX_BODY_BYTES = 80 * 1024;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
const RATE_LIMIT_MAX_LETTERS = Number(process.env.RATE_LIMIT_MAX_LETTERS || 5);

const rateBuckets = new Map();
const store = createStore();
let sendingDueLetters = false;

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

async function main() {
  await store.init();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/api/config" && req.method === "GET") {
        return sendJson(res, 200, { smtpConfigured: isSmtpConfigured() });
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          database: store.kind,
          smtpConfigured: isSmtpConfigured(),
          now: new Date().toISOString(),
        });
      }

      if (url.pathname === "/api/letters" && req.method === "POST") {
        if (!checkRateLimit(req)) {
          return sendJson(res, 429, { error: "提交太频繁了，请稍后再试" });
        }

        return await createLetter(req, res);
      }

      const lookupMatch = url.pathname.match(/^\/api\/letters\/([A-Za-z0-9-]+)$/);
      if (lookupMatch && req.method === "GET") {
        return await getLetter(lookupMatch[1], res);
      }

      if (url.pathname.startsWith("/api/")) {
        return sendJson(res, 404, { error: "接口不存在" });
      }

      return serveStatic(url.pathname, res);
    } catch (error) {
      console.error(error);
      return sendJson(res, error.statusCode || 500, { error: error.message || "服务器暂时无法处理请求" });
    }
  });

  server.listen(PORT, () => {
    console.log(`HFUT time mailbox is running at http://localhost:${PORT}`);
    console.log(`Database: ${store.kind}`);
    console.log(isSmtpConfigured() ? "SMTP configured." : "SMTP not configured. Letters will stay queued.");
  });

  setInterval(sendDueLetters, SEND_INTERVAL_MS);
  setTimeout(sendDueLetters, 2500);
}

async function createLetter(req, res) {
  const payload = await readJson(req);

  if (payload.website) {
    return sendJson(res, 201, {
      lookupCode: "HFUT-OK",
      deliverAt: new Date().toISOString(),
      recipientEmailMasked: "***",
    });
  }

  const letter = validateLetter(payload);
  const lookupCode = createLookupCode();
  const createdAt = new Date().toISOString();

  await store.insertLetter({
    lookupCode,
    senderName: letter.senderName,
    recipientName: letter.recipientName,
    recipientEmail: letter.recipientEmail,
    subject: letter.subject,
    body: letter.body,
    deliverAt: letter.deliverAt,
    createdAt,
  });

  return sendJson(res, 201, {
    lookupCode,
    deliverAt: letter.deliverAt,
    recipientEmailMasked: maskEmail(letter.recipientEmail),
  });
}

async function getLetter(code, res) {
  const normalized = String(code || "").trim().toUpperCase();

  if (!/^[A-Z0-9-]{8,20}$/.test(normalized)) {
    return sendJson(res, 400, { error: "查信码格式不正确" });
  }

  const row = await store.findByCode(normalized);

  if (!row) {
    return sendJson(res, 404, { error: "没有找到这封信" });
  }

  return sendJson(res, 200, {
    lookupCode: row.lookup_code,
    recipientName: row.recipient_name,
    recipientEmailMasked: maskEmail(row.recipient_email),
    subject: row.subject,
    deliverAt: row.deliver_at,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  });
}

async function sendDueLetters() {
  if (sendingDueLetters || !isSmtpConfigured()) {
    return;
  }

  sendingDueLetters = true;

  try {
    const rows = await store.dueLetters(new Date().toISOString(), MAX_SEND_ATTEMPTS);

    for (const row of rows) {
      const changed = await store.markSending(row.id);
      if (changed !== 1) {
        continue;
      }

      try {
        await sendLetterEmail(row);
        await store.markSent(row.id, new Date().toISOString());
        console.log(`Sent letter ${row.lookup_code} to ${row.recipient_email}`);
      } catch (error) {
        const attempts = row.attempts + 1;
        const nextStatus = attempts >= MAX_SEND_ATTEMPTS ? "failed" : "scheduled";
        await store.markRetry(row.id, nextStatus, attempts, cleanError(error));
        console.error(`Failed sending letter ${row.lookup_code}:`, error.message);
      }
    }
  } finally {
    sendingDueLetters = false;
  }
}

async function sendLetterEmail(letter) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  const subject = letter.subject || "一封来自过去的信";
  const escapedBody = escapeHtml(letter.body).replace(/\n/g, "<br />");

  await transporter.sendMail({
    from: getMailFrom(),
    to: letter.recipient_email,
    subject,
    text: [
      `${letter.recipient_name}：`,
      "",
      "这是你曾经写给未来自己的信。",
      "",
      letter.body,
      "",
      `写信人：${letter.sender_name}`,
      `查信码：${letter.lookup_code}`,
      `时间信箱：${siteUrl}`,
    ].join("\n"),
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.75; color: #18212f;">
        <p>${escapeHtml(letter.recipient_name)}：</p>
        <p>这是你曾经写给未来自己的信。</p>
        <div style="margin: 22px 0; padding: 18px; border-left: 4px solid #14634f; background: #f5f7f8;">
          ${escapedBody}
        </div>
        <p>写信人：${escapeHtml(letter.sender_name)}</p>
        <p>查信码：<strong>${escapeHtml(letter.lookup_code)}</strong></p>
        <p><a href="${escapeHtml(siteUrl)}">HFUT 时间信箱</a></p>
      </div>
    `,
  });
}

function createStore() {
  if (process.env.DATABASE_URL) {
    return createPostgresStore();
  }

  return createSqliteStore();
}

function createSqliteStore() {
  let db;
  let statements;

  return {
    kind: "sqlite",
    async init() {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      db = new DatabaseSync(DB_PATH);
      db.exec(`
        CREATE TABLE IF NOT EXISTS letters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lookup_code TEXT NOT NULL UNIQUE,
          sender_name TEXT NOT NULL,
          recipient_name TEXT NOT NULL,
          recipient_email TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          deliver_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_letters_due
          ON letters (status, deliver_at);
      `);

      statements = {
        insertLetter: db.prepare(`
          INSERT INTO letters (
            lookup_code, sender_name, recipient_name, recipient_email,
            subject, body, deliver_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `),
        findByCode: db.prepare(`
          SELECT lookup_code, recipient_name, recipient_email, subject,
                 deliver_at, status, attempts, created_at, sent_at
          FROM letters
          WHERE lookup_code = ?
        `),
        dueLetters: db.prepare(`
          SELECT id, lookup_code, sender_name, recipient_name, recipient_email,
                 subject, body, deliver_at, attempts
          FROM letters
          WHERE status = 'scheduled'
            AND deliver_at <= ?
            AND attempts < ?
          ORDER BY deliver_at ASC
          LIMIT 10
        `),
        markSending: db.prepare(`
          UPDATE letters
          SET status = 'sending'
          WHERE id = ? AND status = 'scheduled'
        `),
        markSent: db.prepare(`
          UPDATE letters
          SET status = 'sent', sent_at = ?, last_error = NULL
          WHERE id = ?
        `),
        markRetry: db.prepare(`
          UPDATE letters
          SET status = ?, attempts = ?, last_error = ?
          WHERE id = ?
        `),
      };
    },
    async insertLetter(letter) {
      statements.insertLetter.run(
        letter.lookupCode,
        letter.senderName,
        letter.recipientName,
        letter.recipientEmail,
        letter.subject,
        letter.body,
        letter.deliverAt,
        letter.createdAt,
      );
    },
    async findByCode(code) {
      return statements.findByCode.get(code);
    },
    async dueLetters(now, maxAttempts) {
      return statements.dueLetters.all(now, maxAttempts);
    },
    async markSending(id) {
      return statements.markSending.run(id).changes;
    },
    async markSent(id, sentAt) {
      statements.markSent.run(sentAt, id);
    },
    async markRetry(id, status, attempts, error) {
      statements.markRetry.run(status, attempts, error, id);
    },
  };
}

function createPostgresStore() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS letters (
          id BIGSERIAL PRIMARY KEY,
          lookup_code TEXT NOT NULL UNIQUE,
          sender_name TEXT NOT NULL,
          recipient_name TEXT NOT NULL,
          recipient_email TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          deliver_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_letters_due
          ON letters (status, deliver_at);
      `);
    },
    async insertLetter(letter) {
      await pool.query(
        `
          INSERT INTO letters (
            lookup_code, sender_name, recipient_name, recipient_email,
            subject, body, deliver_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          letter.lookupCode,
          letter.senderName,
          letter.recipientName,
          letter.recipientEmail,
          letter.subject,
          letter.body,
          letter.deliverAt,
          letter.createdAt,
        ],
      );
    },
    async findByCode(code) {
      const result = await pool.query(
        `
          SELECT lookup_code, recipient_name, recipient_email, subject,
                 deliver_at, status, attempts, created_at, sent_at
          FROM letters
          WHERE lookup_code = $1
        `,
        [code],
      );
      return result.rows[0];
    },
    async dueLetters(now, maxAttempts) {
      const result = await pool.query(
        `
          SELECT id, lookup_code, sender_name, recipient_name, recipient_email,
                 subject, body, deliver_at, attempts
          FROM letters
          WHERE status = 'scheduled'
            AND deliver_at <= $1
            AND attempts < $2
          ORDER BY deliver_at ASC
          LIMIT 10
        `,
        [now, maxAttempts],
      );
      return result.rows;
    },
    async markSending(id) {
      const result = await pool.query(
        `
          UPDATE letters
          SET status = 'sending'
          WHERE id = $1 AND status = 'scheduled'
        `,
        [id],
      );
      return result.rowCount;
    },
    async markSent(id, sentAt) {
      await pool.query(
        `
          UPDATE letters
          SET status = 'sent', sent_at = $1, last_error = NULL
          WHERE id = $2
        `,
        [sentAt, id],
      );
    },
    async markRetry(id, status, attempts, error) {
      await pool.query(
        `
          UPDATE letters
          SET status = $1, attempts = $2, last_error = $3
          WHERE id = $4
        `,
        [status, attempts, error, id],
      );
    },
  };
}

function validateLetter(payload) {
  const senderName = cleanText(payload.senderName, 1, 40, "写信人");
  const recipientName = cleanText(payload.recipientName, 1, 40, "收件人");
  const recipientEmail = cleanEmail(payload.recipientEmail);
  const subject = cleanText(payload.subject, 1, 100, "邮件标题");
  const body = cleanText(payload.body, 10, 5000, "信件内容");
  const deliverAt = new Date(payload.deliverAt);

  if (Number.isNaN(deliverAt.getTime())) {
    throw httpError(400, "送达时间不正确");
  }

  const earliest = Date.now() + 60_000;
  const latest = Date.now() + 1000 * 60 * 60 * 24 * 365 * 20;

  if (deliverAt.getTime() < earliest) {
    throw httpError(400, "送达时间至少需要晚于当前时间 1 分钟");
  }

  if (deliverAt.getTime() > latest) {
    throw httpError(400, "送达时间不能超过 20 年");
  }

  return {
    senderName,
    recipientName,
    recipientEmail,
    subject,
    body,
    deliverAt: deliverAt.toISOString(),
  };
}

function cleanText(value, min, max, label) {
  const text = String(value || "").trim();

  if (text.length < min) {
    throw httpError(400, `${label}太短了`);
  }

  if (text.length > max) {
    throw httpError(400, `${label}不能超过 ${max} 个字`);
  }

  return text;
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    throw httpError(400, "收件邮箱格式不正确");
  }

  return email;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(httpError(413, "信件内容太长了"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "请求内容不是有效 JSON"));
      }
    });

    req.on("error", reject);
  });
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(__dirname, safePath));

  if (!filePath.startsWith(__dirname)) {
    return sendJson(res, 403, { error: "拒绝访问" });
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream";
}

function createLookupCode() {
  return `HFUT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${"*".repeat(Math.max(3, name.length - visible.length))}@${domain}`;
}

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function checkRateLimit(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateBuckets.set(ip, bucket);

  for (const [key, value] of rateBuckets) {
    if (value.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }

  return bucket.count <= RATE_LIMIT_MAX_LETTERS;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function getMailFrom() {
  if (process.env.SMTP_FROM) {
    return process.env.SMTP_FROM;
  }

  return `"HFUT 时间信箱" <${process.env.SMTP_USER}>`;
}

function cleanError(error) {
  return String(error && error.message ? error.message : error).slice(0, 400);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
