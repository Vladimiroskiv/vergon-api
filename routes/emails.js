const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const auth = require('../middleware/auth');

const CPANEL_URL = process.env.CPANEL_URL || 'https://vergon.art:2083';
const CPANEL_USER = process.env.CPANEL_USER;
const CPANEL_PASS = process.env.CPANEL_PASS;
const DOMAIN = 'vergon.art';

const cpanel = axios.create({
  baseURL: CPANEL_URL,
  auth: { username: CPANEL_USER, password: CPANEL_PASS },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

// List email accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const response = await cpanel.get('/execute/Email/list_pops_with_disk', {
      params: { domain: DOMAIN, no_system_accts: 1 },
    });
    const accounts = response.data.data || [];
    res.json({ accounts });
  } catch (err) {
    console.error('cPanel list error:', err.message);
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
    const response = await cpanel.post('/execute/Email/add_pop', null, {
      params: { email: username, domain: DOMAIN, password, quota },
    });
    if (response.data.status === 1) {
      res.json({ success: true, email: `${username}@${DOMAIN}` });
    } else {
      const errMsg = response.data.errors?.[0] || 'Eroare la creare';
      res.status(400).json({ error: errMsg });
    }
  } catch (err) {
    console.error('cPanel create error:', err.message);
    res.status(500).json({ error: 'Eroare la creare email' });
  }
});

// Delete email account
router.delete('/accounts/:username', auth, async (req, res) => {
  const { username } = req.params;
  try {
    const response = await cpanel.post('/execute/Email/delete_pop', null, {
      params: { email: username, domain: DOMAIN },
    });
    if (response.data.status === 1) {
      res.json({ success: true });
    } else {
      const errMsg = response.data.errors?.[0] || 'Eroare la stergere';
      res.status(400).json({ error: errMsg });
    }
  } catch (err) {
    console.error('cPanel delete error:', err.message);
    res.status(500).json({ error: 'Eroare la stergere email' });
  }
});

module.exports = router;
