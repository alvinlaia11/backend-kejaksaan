const express = require('express');
const router = express.Router();
const { verifyToken, isAdmin, isUser } = require('../middleware/auth');

// Route yang memerlukan autentikasi
router.get('/protected', verifyToken, (req, res) => {
  // Handler
});

// Route khusus admin
router.post('/admin-only', verifyToken, isAdmin, (req, res) => {
  // Handler
});

// Route untuk user biasa
router.get('/user-data', verifyToken, isUser, (req, res) => {
  // Handler
});

module.exports = router; 