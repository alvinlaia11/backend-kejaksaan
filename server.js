require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { pool, query, testConnection } = require('./db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const schedule = require('node-schedule');
const fs = require('fs');
const filesRouter = require('./routes/files');
const supabase = require('./config/supabase');
const { verifyToken, validateLogin, handleAuthError } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  "http://localhost:3000", 
  "http://localhost:3001", 
  "http://localhost:3002",
  "https://frontend-kejaksaan-production.up.railway.app" // Tambahkan URL frontend production
];

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  }
});

app.use(express.json());
app.use(cors({
  origin: function(origin, callback) {
    // Izinkan requests tanpa origin (seperti mobile apps atau curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'CORS policy tidak mengizinkan akses dari origin ini.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Tambahkan ini setelah konfigurasi CORS
app.use('/api/files', filesRouter);

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// 1. Buat folder uploads jika belum ada
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 2. Konfigurasi multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diizinkan'));
    }
  }
});

const userSockets = new Map();

// Tambahkan middleware socket authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// Handle socket connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);
  userSockets.set(socket.userId, socket);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
    userSockets.delete(socket.userId);
  });
});

const sendAndSaveNotification = async (userId, message, caseId) => {
  const client = await pool.connect();
  try {
    // Cek apakah notifikasi untuk kasus ini sudah ada
    const existingNotif = await client.query(
      `SELECT * FROM notifications 
       WHERE case_id = $1 AND user_id = $2 
       AND DATE(created_at) = CURRENT_DATE`,
      [caseId, userId]
    );

    if (existingNotif.rows.length > 0) {
      console.log('Notification already exists for case:', caseId);
      return null;
    }

    // Hitung schedule_date (H-1)
    const caseResult = await client.query(
      'SELECT date FROM cases WHERE id = $1',
      [caseId]
    );
    
    if (caseResult.rows.length === 0) {
      throw new Error('Case not found');
    }

    const caseDate = new Date(caseResult.rows[0].date);
    const scheduleDate = new Date(caseDate);
    scheduleDate.setDate(scheduleDate.getDate() - 1);

    // Simpan notifikasi baru
    const result = await client.query(
      `INSERT INTO notifications 
       (user_id, message, case_id, is_read, is_sent, schedule_date, type) 
       VALUES ($1, $2, $3, false, true, $4, 'reminder') 
       RETURNING *`,
      [userId, message, caseId, scheduleDate]
    );
    
    const notification = result.rows[0];
    console.log('New notification created:', notification);

    // Kirim notifikasi melalui socket jika user online
    const userSocket = userSockets.get(userId);
    if (userSocket) {
      console.log('Sending notification through socket to user:', userId);
      userSocket.emit('notification', {
        ...notification,
        title: 'Pengingat Jadwal',
        message: message,
        type: 'reminder'
      });
    } else {
      console.log('User socket not found for user:', userId);
    }

    return notification;
  } catch (error) {
    console.error('Error in sendAndSaveNotification:', error);
    throw error;
  } finally {
    client.release();
  }
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    console.log('Access denied. User is not an admin:', req.user);
    return res.status(403).json({ error: "Akses ditolak. Hanya admin yang diizinkan." });
  }
  console.log('Admin access granted for user:', req.user);
  next();
};

const checkPendingNotifications = async (userId) => {
  const client = await pool.connect();
  try {
    // Ambil semua kasus yang belum dinotifikasi dan jadwalnya H-1
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const result = await client.query(`
      SELECT c.* 
      FROM cases c
      WHERE c.user_id = $1 
      AND DATE(c.date) = DATE($2)
      AND c.notification_sent = false
    `, [userId, tomorrow]);

    console.log(`Found ${result.rows.length} pending notifications for user ${userId}`);

    for (const caseData of result.rows) {
      try {
        const formattedDate = formatDate(caseData.date);
        const message = `Reminder: Kasus "${caseData.title}" dijadwalkan untuk besok (${formattedDate})`;
        
        await sendAndSaveNotification(userId, message, caseData.id);
        
        // Update status notification_sent
        await client.query(
          'UPDATE cases SET notification_sent = true WHERE id = $1',
          [caseData.id]
        );

        console.log(`Notification sent for case ${caseData.id}`);
      } catch (err) {
        console.error(`Error processing notification for case ${caseData.id}:`, err);
      }
    }

    return result.rows.length; // Return jumlah notifikasi yang dikirim
  } catch (error) {
    console.error('Error checking pending notifications:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Gunakan validateLogin middleware untuk endpoint login
app.post('/api/auth/login', validateLogin, async (req, res) => {
  const { email, password } = req.body;
  console.log('Login attempt for email:', email);
  
  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: "Email atau password salah" 
      });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ 
        success: false,
        error: "Email atau password salah" 
      });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Cek notifikasi yang pending setelah login berhasil
    try {
      const notificationCount = await checkPendingNotifications(user.id);
      console.log(`Sent ${notificationCount} notifications for user ${user.id}`);
    } catch (notifError) {
      console.error('Error checking notifications:', notifError);
      // Lanjutkan proses login meskipun ada error pada notifikasi
    }

    console.log('Login successful:', {
      username: user.username,
      role: user.role
    });

    res.json({ 
      success: true,
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        role: user.role 
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ 
      success: false,
      error: "Terjadi kesalahan server" 
    });
  }
});

// Gunakan error handler di akhir
app.use(handleAuthError);

app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, username, email, role, position, phone, office, avatar_url FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in profile endpoint:', err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.put('/api/profile', verifyToken, async (req, res) => {
  const { username, position, email, phone, office } = req.body;
  try {
    const result = await query(
      `UPDATE users 
       SET username = $1, position = $2, email = $3, phone = $4, office = $5 
       WHERE id = $6 
       RETURNING id, username, email, position, phone, office, avatar_url`,
      [username, position, email, phone, office, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Pengguna tidak ditemukan" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ error: "Terjadi kesalahan saat memperbarui profil" });
  }
});

app.post('/api/profile/avatar', verifyToken, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada file yang diunggah" });
    }

    const userId = req.user.userId;
    const fileName = `avatar-${userId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const filePath = `avatars/${fileName}`;

    // Upload ke Supabase Storage
    const { data, error: uploadError } = await supabase.storage
      .from('files') // nama bucket
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      throw uploadError;
    }

    // Dapatkan URL publik
    const { data: { publicUrl } } = supabase.storage
      .from('files')
      .getPublicUrl(filePath);

    console.log('Avatar URL:', publicUrl);

    // Update URL avatar di database
    const result = await query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, avatar_url',
      [publicUrl, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Pengguna tidak ditemukan" });
    }

    res.json({ 
      success: true,
      message: "Avatar berhasil diupload",
      avatar_url: publicUrl 
    });

  } catch (err) {
    console.error('Error updating avatar:', err);
    res.status(500).json({ error: "Terjadi kesalahan saat memperbarui avatar" });
  }
});

app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.post('/api/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await query(
      'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [username, email, hashedPassword, role]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.put('/api/users/:id', verifyToken, async (req, res) => {
  const { username, email, password, position, phone, office } = req.body;
  const userId = req.params.id;
  const client = await pool.connect();

  try {
    // Verifikasi role admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Hanya admin yang dapat mengedit pengguna' 
      });
    }

    let queryText, queryParams;
    
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      queryText = `
        UPDATE users 
        SET username = $1, email = $2, password = $3, position = $4, phone = $5, office = $6 
        WHERE id = $7
        RETURNING id, username, email, position, phone, office
      `;
      queryParams = [username, email, hashedPassword, position, phone, office, userId];
    } else {
      queryText = `
        UPDATE users 
        SET username = $1, email = $2, position = $3, phone = $4, office = $5 
        WHERE id = $6
        RETURNING id, username, email, position, phone, office
      `;
      queryParams = [username, email, position, phone, office, userId];
    }

    const result = await client.query(queryText, queryParams);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    console.log('User updated:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Gagal memperbarui pengguna' });
  } finally {
    client.release();
  }
});

// Delete user endpoint
app.delete('/api/users/:id', verifyToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    // Verifikasi role admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Hanya admin yang dapat menghapus pengguna' 
      });
    }

    const userId = req.params.id;
    console.log('Attempting to delete user:', userId);

    // Mulai transaction
    await client.query('BEGIN');

    // 1. Hapus files terlebih dahulu
    await client.query(
      'DELETE FROM files WHERE user_id = $1',
      [userId]
    );

    // 2. Hapus folders
    await client.query(
      'DELETE FROM folders WHERE user_id = $1',
      [userId]
    );

    // 3. Hapus notifications
    await client.query(
      'DELETE FROM notifications WHERE user_id = $1',
      [userId]
    );

    // 4. Hapus cases
    await client.query(
      'DELETE FROM cases WHERE user_id = $1',
      [userId]
    );

    // 5. Hapus user tanpa memeriksa role
    const result = await client.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, username',
      [userId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Pengguna tidak ditemukan'
      });
    }

    // Commit transaction
    await client.query('COMMIT');

    console.log('User deleted successfully:', result.rows[0]);
    res.json({ 
      success: true,
      message: 'Pengguna berhasil dihapus',
      deletedUser: result.rows[0]
    });

  } catch (err) {
    // Rollback jika terjadi error
    await client.query('ROLLBACK');
    
    console.error('Error deleting user:', err);
    res.status(500).json({
      success: false,
      error: 'Terjadi kesalahan saat menghapus pengguna',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
});

app.get('/api/cases', verifyToken, async (req, res) => {
  try {
    const { type } = req.query;
    const userId = req.user.userId;

    const query = `
      SELECT 
        c.*,
        COALESCE(c.status, 'Menunggu') as status
      FROM cases c
      WHERE c.user_id = $1
      ${type ? 'AND LOWER(c.type) = LOWER($2)' : ''}
      ORDER BY c.date DESC
    `;

    const values = [userId];
    if (type) values.push(type);

    const result = await pool.query(query, values);
    console.log(`Found ${result.rows.length} cases with data:`, result.rows);

    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      error: 'Terjadi kesalahan server',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

app.get('/api/cases/:id', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        c.*,
        u.username as created_by_username,
        to_char(c.date, 'YYYY-MM-DD') as formatted_date,
        COALESCE(c.status, 'Menunggu') as status
      FROM cases c
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.id = $1 AND c.user_id = $2
    `;

    const result = await client.query(query, [id, req.user.userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Kasus tidak ditemukan"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching case detail:', error);
    res.status(500).json({
      error: "Terjadi kesalahan saat mengambil detail kasus",
      message: error.message
    });
  } finally {
    client.release();
  }
});

app.post('/api/cases', verifyToken, async (req, res) => {
  const { title, date, description, parties, type, witnesses, prosecutor } = req.body;
  console.log('Adding new case:', { title, date, type, witnesses, prosecutor }, 'User ID:', req.user.userId);
  
  try {
    const result = await query(
      `INSERT INTO cases (
        title, date, description, parties, type, 
        user_id, notification_sent, created_by,
        witnesses, prosecutor
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
      RETURNING *`,
      [
        title, 
        date, 
        description, 
        parties, 
        type, 
        req.user.userId, 
        false, 
        req.user.userId,
        witnesses,
        prosecutor
      ]
    );
    
    console.log('New case added successfully:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding new case:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server saat menambah kasus baru' });
  }
});

app.put('/api/cases/:id', verifyToken, async (req, res) => {
  const { title, date, description, parties, type, witnesses, prosecutor } = req.body;
  console.log('Updating case:', req.params.id, { title, date, type, witnesses, prosecutor }, 'User ID:', req.user.userId);
  
  try {
    const result = await query(
      `UPDATE cases 
       SET title = $1, date = $2, description = $3, parties = $4, type = $5, 
           witnesses = $6, prosecutor = $7 
       WHERE id = $8 AND user_id = $9 
       RETURNING *`,
      [title, date, description, parties, type, witnesses, prosecutor, req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      console.log('Case not found for update:', req.params.id);
      return res.status(404).json({ error: 'Kasus tidak ditemukan' });
    }
    
    console.log('Case updated successfully:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating case:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server saat mengupdate kasus' });
  }
});

app.delete('/api/cases/:id', verifyToken, async (req, res) => {
  const caseId = req.params.id;
  const userId = req.user.userId;
  
  console.log(`Attempting to delete case ${caseId} by user ${userId}`);
  
  try {
    await query('BEGIN');

    try {
      await query('DELETE FROM notifications WHERE case_id = $1', [caseId]);

      const result = await query(
        'DELETE FROM cases WHERE id = $1 AND user_id = $2 RETURNING *',
        [caseId, userId]
      );

      if (result.rows.length === 0) {
        await query('ROLLBACK');
        return res.status(404).json({ 
          error: 'Kasus tidak ditemukan atau Anda tidak memiliki akses' 
        });
      }

      await query('COMMIT');

      console.log('Case deleted successfully:', result.rows[0]);
      res.json({ 
        message: 'Kasus berhasil dihapus',
        deletedCase: result.rows[0]
      });

    } catch (innerErr) {
      await query('ROLLBACK');
      throw innerErr;
    }

  } catch (err) {
    console.error('Error deleting case:', err);
    res.status(500).json({ 
      error: 'Terjadi kesalahan server saat menghapus kasus',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

app.get('/api/notifications', verifyToken, async (req, res) => {
  console.log('Fetching notifications for user:', req.user.userId);
  try {
    const result = await query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', 
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server saat mengambil notifikasi' });
  }
});

app.put('/api/notifications/:id/read', verifyToken, async (req, res) => {
  try {
    const result = await query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notifikasi tidak ditemukan' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server saat memperbarui notifikasi' });
  }
});

app.get('/api/test-db', async (req, res) => {
  try {
    const result = await query('SELECT NOW()');
    res.json({ message: "Koneksi database berhasil", timestamp: result.rows[0].now });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ error: "Gagal terhubung ke database" });
  }
});

app.get('/api/test-auth', verifyToken, (req, res) => {
  res.json({ message: "Autentikasi berhasil", user: req.user });
});

app.post('/api/auth/logout', verifyToken, (req, res) => {
  console.log('Logout attempt for user:', req.user.userId);
  res.status(200).json({ message: "Logout berhasil" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', {
    message: err.message,
    stack: err.stack
  });
  
  res.status(500).json({
    error: 'Terjadi kesalahan server',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Error handler untuk CORS
app.use((err, req, res, next) => {
  if (err.name === 'CORSError') {
    res.status(403).json({
      error: 'CORS Error',
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } else {
    next(err);
  }
});

// General error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Tambahkan endpoint untuk update status
app.put('/api/cases/:id/status', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { status } = req.body;
    const { id } = req.params;
    
    console.log('Updating status:', { id, status, userId: req.user.userId });

    const result = await client.query(
      'UPDATE cases SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kasus tidak ditemukan' });
    }

    console.log('Status updated successfully:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Gagal mengubah status' });
  } finally {
    client.release();
  }
});

function formatDate(dateString) {
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return new Date(dateString).toLocaleDateString('id-ID', options);
}

const checkDatabaseConnection = async () => {
  try {
    const connectionTest = await query('SELECT NOW()');
    console.log('Database connection test:', connectionTest.rows[0]);
    
    const usersTable = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
      );
    `);
    console.log('Users table exists:', usersTable.rows[0].exists);
    
    const userCount = await query('SELECT COUNT(*) FROM users');
    console.log('Total users in database:', userCount.rows[0].count);
    
    return true;
  } catch (err) {
    console.error('Database check failed:', err);
    return false;
  }
};

const updateNotificationsTable = async () => {
  try {
    const columnCheck = await query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'notifications';
    `);
    
    const existingColumns = columnCheck.rows.map(row => row.column_name);
    console.log('Existing columns:', existingColumns);

    const requiredColumns = [
      {
        name: 'case_id',
        definition: 'INTEGER REFERENCES cases(id)'
      },
      {
        name: 'is_sent',
        definition: 'BOOLEAN DEFAULT false'
      },
      {
        name: 'schedule_date',
        definition: 'TIMESTAMP'
      }
    ];

    for (const column of requiredColumns) {
      if (!existingColumns.includes(column.name)) {
        console.log(`Adding column ${column.name}...`);
        await query(`
          ALTER TABLE notifications 
          ADD COLUMN IF NOT EXISTS ${column.name} ${column.definition};
        `);
        console.log(`Column ${column.name} added successfully`);
      }
    }

  } catch (err) {
    console.error('Error updating notifications table:', err);
    throw err;
  }
};

const setupDatabase = async () => {
  try {
    await query(`
      ALTER TABLE notifications 
      DROP CONSTRAINT IF EXISTS notifications_case_id_fkey,
      ADD CONSTRAINT notifications_case_id_fkey 
      FOREIGN KEY (case_id) 
      REFERENCES cases(id) 
      ON DELETE CASCADE;
    `);
    console.log('Database constraints updated successfully');
  } catch (err) {
    console.error('Error setting up database constraints:', err);
    throw err;
  }
};

const startServer = async () => {
  try {
    // Test koneksi database
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed');
    }

    // Start server
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log('Database connected successfully');
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
};

// Fungsi untuk memeriksa jadwal kasus dan mengirim notifikasi
const checkUpcomingCases = async () => {
  try {
    // Ambil kasus yang jadwalnya H-1 dari sekarang
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const result = await query(`
      SELECT c.*, u.id as user_id 
      FROM cases c
      JOIN users u ON c.user_id = u.id
      WHERE DATE(c.date) = DATE($1)
      AND c.notification_sent = false
    `, [tomorrow]);

    console.log(`Checking ${result.rows.length} upcoming cases for notifications`);

    for (const caseData of result.rows) {
      try {
        // Format tanggal untuk pesan
        const formattedDate = formatDate(caseData.date);
        
        // Buat pesan notifikasi
        const message = `Reminder: Kasus "${caseData.title}" dijadwalkan untuk besok (${formattedDate})`;
        
        // Kirim dan simpan notifikasi
        await sendAndSaveNotification(caseData.user_id, message, caseData.id);
        
        // Update status notification_sent
        await query(
          'UPDATE cases SET notification_sent = true WHERE id = $1',
          [caseData.id]
        );

        console.log(`Notification sent for case ${caseData.id}`);
      } catch (err) {
        console.error(`Error processing notification for case ${caseData.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Error checking upcoming cases:', err);
  }
};

// Jalankan pengecekan setiap jam
schedule.scheduleJob('0 * * * *', checkUpcomingCases);

// Jalankan pengecekan saat server pertama kali start
checkUpcomingCases();

// Tambahkan endpoint untuk memaksa cek notifikasi (untuk testing)
app.post('/api/check-notifications', verifyToken, async (req, res) => {
  try {
    await checkUpcomingCases();
    res.json({ message: 'Notification check triggered successfully' });
  } catch (err) {
    console.error('Error triggering notification check:', err);
    res.status(500).json({ error: 'Failed to check notifications' });
  }
});

startServer();

module.exports = {
  app,
  server,
  io
};
