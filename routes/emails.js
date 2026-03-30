const express = require('express');
const router = express.Router();
const axios = require('axios');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../config/db');
const auth = require('../middleware/auth');

const SMTP_HOST = 'mail.vergon.art';
const SMTP_PORT = 465;

const transporterCache = {};
function getTransporter(email, password) {
  if (!transporterCache[email]) {
    transporterCache[email] = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true,
      pool: true,
      maxConnections: 3,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
    });
  }
  return transporterCache[email];
}

const PROXY_URL = process.env.CPANEL_PROXY_URL || 'https://vergon.art/cpanel-proxy.php';
const PROXY_SECRET = process.env.CPANEL_PROXY_SECRET || 'vrgn_proxy_2026_xK9mP';
const IMAP_HOST = 'mail.vergon.art';
const IMAP_PORT = 993;
const ENC_KEY = process.env.EMAIL_ENC_KEY || 'vergon_enc_key_2026_32byteslong!!';
const ENC_KEY_BUF = Buffer.from(ENC_KEY.slice(0, 32));

const proxyHeaders = { 'X-Proxy-Secret': PROXY_SECRET };

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const [ivHex, encHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString();
}

function fetchEmails(user, password, limit = 20, folder = 'INBOX') {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user, password,
      host: IMAP_HOST, port: IMAP_PORT,
      tls: true, tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000, authTimeout: 10000,
    });

    const mailbox = (folder === 'UNSEEN' || folder === 'SEEN') ? 'INBOX' : folder;
    const searchCriteria = folder === 'UNSEEN' ? ['UNSEEN'] : folder === 'SEEN' ? ['SEEN'] : ['ALL'];

    imap.once('ready', () => {
      imap.openBox(mailbox, true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        imap.search(searchCriteria, (err, uids) => {
          if (err) { imap.end(); return reject(err); }
          if (!uids || uids.length === 0) { imap.end(); return resolve([]); }

          const slice = uids.slice(-limit);
          const fetch = imap.fetch(slice, {
            bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
            struct: true,
          });

          const messages = [];
          fetch.on('message', (msg, seqno) => {
            const message = { seqno };
            msg.on('body', (stream) => {
              let buffer = '';
              stream.on('data', (chunk) => buffer += chunk.toString());
              stream.once('end', () => {
                const parsed = Imap.parseHeader(buffer);
                message.from = parsed.from?.[0] || '';
                message.subject = parsed.subject?.[0] || '(fara subiect)';
                message.date = parsed.date?.[0] || '';
              });
            });
            msg.once('end', () => messages.push(message));
          });

          fetch.once('end', () => { imap.end(); resolve(messages.reverse()); });
          fetch.once('error', (e) => { imap.end(); reject(e); });
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

function fetchEmailBody(user, password, seqno, folder = 'INBOX') {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
    });

    const mailbox = (folder === 'UNSEEN' || folder === 'SEEN') ? 'INBOX' : folder;
    imap.once('ready', () => {
      imap.openBox(mailbox, false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const fetch = imap.seq.fetch(seqno, { bodies: '', markSeen: true });
        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            simpleParser(stream, (err, parsed) => {
              imap.end();
              if (err) return reject(err);
              resolve({
                from: parsed.from?.text || '',
                subject: parsed.subject || '',
                date: parsed.date || '',
                text: parsed.text || '',
                html: parsed.html || '',
              });
            });
          });
        });

        fetch.once('error', (e) => { imap.end(); reject(e); });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

// List email accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const response = await axios.get(`${PROXY_URL}?action=list`, { headers: proxyHeaders });
    const accounts = response.data.data || [];
    res.json({ accounts });
  } catch (err) {
    console.error('Proxy list error:', err.message);
    res.status(500).json({ error: 'Eroare la listare emailuri' });
  }
});

// Create email account
router.post('/accounts', auth, async (req, res) => {
  const { username, password, quota = 250 } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username si parola sunt obligatorii' });
  }
  try {
    const response = await axios.post(`${PROXY_URL}?action=create`, { username, password, quota }, { headers: proxyHeaders });
    if (response.data.status === 1) {
      const email = `${username}@vergon.art`;
      const password_enc = encrypt(password);
      await db.query(
        'INSERT INTO email_accounts (email, password_enc) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_enc = $2',
        [email, password_enc]
      );
      res.json({ success: true, email });
    } else {
      const errMsg = response.data.errors?.[0] || 'Eroare la creare';
      res.status(400).json({ error: errMsg });
    }
  } catch (err) {
    console.error('Proxy create error:', err.message);
    res.status(500).json({ error: 'Eroare la creare email' });
  }
});

// Delete email account
router.delete('/accounts/:username', auth, async (req, res) => {
  const { username } = req.params;
  try {
    const response = await axios.post(`${PROXY_URL}?action=delete`, { username }, { headers: proxyHeaders });
    if (response.data.status === 1) {
      await db.query('DELETE FROM email_accounts WHERE email = $1', [`${username}@vergon.art`]);
      res.json({ success: true });
    } else {
      const errMsg = response.data.errors?.[0] || 'Eroare la stergere';
      res.status(400).json({ error: errMsg });
    }
  } catch (err) {
    console.error('Proxy delete error:', err.message);
    res.status(500).json({ error: 'Eroare la stergere email' });
  }
});

// Get inbox for an email account (with cache)
router.get('/accounts/:email/inbox', auth, async (req, res) => {
  const { email } = req.params;
  const { folder = 'INBOX', refresh = 'false' } = req.query;
  try {
    const result = await db.query('SELECT password_enc FROM email_accounts WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email negasit in baza de date' });

    // Serve from cache if fresh (< 5 min) and no force refresh
    if (refresh !== 'true') {
      const cached = await db.query(
        `SELECT seqno, from_addr, subject, date_received, is_seen
         FROM email_cache
         WHERE account_email = $1 AND folder = $2
         AND cached_at > NOW() - INTERVAL '5 minutes'
         ORDER BY date_received DESC NULLS LAST LIMIT 50`,
        [email, folder]
      );
      if (cached.rows.length > 0) {
        const messages = cached.rows.map(r => ({
          seqno: r.seqno,
          from: r.from_addr,
          subject: r.subject,
          date: r.date_received,
          seen: r.is_seen,
        }));
        return res.json({ messages, fromCache: true });
      }
    }

    // Fetch fresh from IMAP
    const password = decrypt(result.rows[0].password_enc);
    const messages = await fetchEmails(email, password, 50, folder);

    // Save to cache
    for (const msg of messages) {
      await db.query(
        `INSERT INTO email_cache (account_email, folder, seqno, from_addr, subject, date_received, cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (account_email, folder, seqno) DO UPDATE SET
         from_addr = EXCLUDED.from_addr, subject = EXCLUDED.subject,
         date_received = EXCLUDED.date_received, cached_at = NOW()`,
        [email, folder, msg.seqno, msg.from, msg.subject, msg.date ? new Date(msg.date) : null]
      );
    }

    res.json({ messages });
  } catch (err) {
    console.error('IMAP inbox error:', err.message);
    res.status(500).json({ error: 'Eroare la citire inbox' });
  }
});

// Get full email message (with body cache)
router.get('/accounts/:email/message/:seqno', auth, async (req, res) => {
  const { email, seqno } = req.params;
  const { folder = 'INBOX' } = req.query;
  try {
    // Check body cache first
    const cached = await db.query(
      'SELECT body_text, body_html, from_addr, subject, date_received FROM email_cache WHERE account_email = $1 AND folder = $2 AND seqno = $3 AND body_html IS NOT NULL',
      [email, folder, parseInt(seqno)]
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0];
      return res.json({ from: r.from_addr, subject: r.subject, date: r.date_received, text: r.body_text, html: r.body_html });
    }

    const result = await db.query('SELECT password_enc FROM email_accounts WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email negasit in baza de date' });
    const password = decrypt(result.rows[0].password_enc);
    const message = await fetchEmailBody(email, password, parseInt(seqno), folder);

    // Save body to cache
    await db.query(
      `INSERT INTO email_cache (account_email, folder, seqno, from_addr, subject, date_received, body_text, body_html, is_seen, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
       ON CONFLICT (account_email, folder, seqno) DO UPDATE SET
       body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html, is_seen = true, cached_at = NOW()`,
      [email, folder, parseInt(seqno), message.from, message.subject, message.date ? new Date(message.date) : null, message.text, message.html]
    );

    res.json(message);
  } catch (err) {
    console.error('IMAP message error:', err.message);
    res.status(500).json({ error: 'Eroare la citire mesaj' });
  }
});

// Move email to Trash
router.post('/accounts/:email/message/:seqno/trash', auth, async (req, res) => {
  const { email, seqno } = req.params;
  const { folder = 'INBOX' } = req.body;
  try {
    const result = await db.query('SELECT password_enc FROM email_accounts WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email negasit' });
    const password = decrypt(result.rows[0].password_enc);

    await new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email, password,
        host: IMAP_HOST, port: IMAP_PORT,
        tls: true, tlsOptions: { rejectUnauthorized: false },
        connTimeout: 10000, authTimeout: 10000,
      });
      imap.once('ready', () => {
        imap.openBox(folder, false, (err) => {
          if (err) { imap.end(); return reject(err); }
          imap.seq.move(parseInt(seqno), 'INBOX.Trash', (err) => {
            imap.end();
            if (err) return reject(err);
            resolve();
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });

    // Remove from cache
    await db.query('DELETE FROM email_cache WHERE account_email = $1 AND folder = $2 AND seqno = $3', [email, folder, parseInt(seqno)]);
    res.json({ success: true });
  } catch (err) {
    console.error('IMAP move to trash error:', err.message);
    res.status(500).json({ error: 'Eroare la mutare in gunoi' });
  }
});

// Delete email from inbox
router.delete('/accounts/:email/message/:seqno', auth, async (req, res) => {
  const { email, seqno } = req.params;
  const { folder = 'INBOX' } = req.query;
  try {
    const result = await db.query('SELECT password_enc FROM email_accounts WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email negasit' });
    const password = decrypt(result.rows[0].password_enc);

    await new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email, password,
        host: IMAP_HOST, port: IMAP_PORT,
        tls: true, tlsOptions: { rejectUnauthorized: false },
        connTimeout: 10000, authTimeout: 10000,
      });
      const mailbox = (folder === 'UNSEEN' || folder === 'SEEN') ? 'INBOX' : folder;
      imap.once('ready', () => {
        imap.openBox(mailbox, false, (err) => {
          if (err) { imap.end(); return reject(err); }
          imap.seq.addFlags(parseInt(seqno), '\\Deleted', (err) => {
            if (err) { imap.end(); return reject(err); }
            imap.expunge((err) => {
              imap.end();
              if (err) return reject(err);
              resolve();
            });
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });

    // Remove from cache
    await db.query('DELETE FROM email_cache WHERE account_email = $1 AND folder = $2 AND seqno = $3', [email, folder, parseInt(seqno)]);
    res.json({ success: true });
  } catch (err) {
    console.error('IMAP delete error:', err.message);
    res.status(500).json({ error: 'Eroare la stergere mesaj' });
  }
});

// Send email
router.post('/accounts/:email/send', auth, async (req, res) => {
  const { email } = req.params;
  const { to, subject, body, replyTo } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Destinatar, subiect si mesaj sunt obligatorii' });
  }

  try {
    const result = await db.query('SELECT password_enc FROM email_accounts WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Email negasit in baza de date' });
    }
    const password = decrypt(result.rows[0].password_enc);

    const transporter = getTransporter(email, password);

    const mailOptions = {
      from: email,
      to,
      subject,
      text: body,
    };

    if (replyTo) {
      mailOptions.inReplyTo = replyTo;
      mailOptions.references = replyTo;
    }

    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('SMTP send error:', err.message);
    res.status(500).json({ error: 'Eroare la trimitere email: ' + err.message });
  }
});

module.exports = router;
