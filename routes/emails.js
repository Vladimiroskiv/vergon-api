const express = require('express');
const router = express.Router();
const axios = require('axios');
const auth = require('../middleware/auth');

const PROXY_URL = process.env.CPANEL_PROXY_URL || 'https://vergon.art/cpanel-proxy.php';
const PROXY_SECRET = process.env.CPANEL_PROXY_SECRET || 'vrgn_proxy_2026_xK9mP';

const proxyHeaders = { 'X-Proxy-Secret': PROXY_SECRET };

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
      res.json({ success: true, email: `${username}@vergon.art` });
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

module.exports = router;
