const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// Get all email accounts
router.get('/accounts', auth, (req, res) => {
  res.json({ accounts: [] });
});

module.exports = router;
