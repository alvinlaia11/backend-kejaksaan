const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

const verifyToken = (req, res, next) => {
  try {
    const bearerHeader = req.headers.authorization;
    
    if (!bearerHeader) {
      return res.status(401).json({ 
        success: false,
        error: "Akses ditolak. Token tidak ditemukan."
      });
    }

    const token = bearerHeader.startsWith('Bearer ') 
      ? bearerHeader.split(' ')[1] 
      : bearerHeader;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: "Token sudah kadaluarsa. Silakan login kembali."
        });
      } else if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          error: "Token tidak valid."
        });
      }
      throw jwtError;
    }
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ 
      success: false,
      error: "Token tidak valid.",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

const validateLogin = (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email dan password harus diisi"
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      error: "Format email tidak valid"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      error: "Password minimal 6 karakter"
    });
  }

  next();
};

const handleAuthError = (err, req, res, next) => {
  console.error('Authentication error:', err);
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      error: "Akses tidak diizinkan. Silakan login kembali."
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }

  res.status(500).json({
    success: false,
    error: "Terjadi kesalahan pada server"
  });
};

module.exports = { 
  verifyToken,
  validateLogin,
  handleAuthError
};
