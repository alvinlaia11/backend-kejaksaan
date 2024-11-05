const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const supabase = require('../config/supabase');

router.use(verifyToken);

// Konfigurasi multer dengan error handling
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    try {
      const uploadDir = path.join(__dirname, '../uploads');
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Tambahkan mime type untuk Word documents
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/msword', // .doc
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/vnd.ms-word', // Alternatif untuk .doc
      'application/vnd.ms-word.document.macroEnabled.12' // .docm
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Hanya gambar, PDF, dan dokumen Word yang diizinkan.'));
    }
  }
});

// GET endpoint untuk files dan folders
router.get('/', async (req, res) => {
  try {
    const { path = '' } = req.query;
    const userId = req.user.userId;
    
    console.log('Debug - GET Request:', { path, userId });

    // Perbaiki query files untuk menampilkan semua kolom yang diperlukan
    const filesQuery = `
      SELECT 
        f.id,
        f.filename,
        f.original_name,
        f.path,
        f.created_at,
        f.file_url,
        f.file_type
      FROM files f
      WHERE f.user_id = $1
      AND COALESCE(f.path, '') = $2
      ORDER BY f.created_at DESC
    `;
    
    const foldersQuery = `
      SELECT id, name, path, created_at 
      FROM folders 
      WHERE user_id = $1 
      AND COALESCE(path, '') = $2
      ORDER BY name ASC
    `;

    console.log('Debug - Executing queries with:', { userId, path });
    
    // Jalankan query
    const [filesResult, foldersResult] = await Promise.all([
      db.query(filesQuery, [userId, path]),
      db.query(foldersQuery, [userId, path])
    ]);

    // Modifikasi untuk menambahkan preview URL untuk file gambar
    const files = filesResult.rows.map(file => {
      const isImage = file.file_type?.startsWith('image/');
      return {
        id: file.id,
        name: file.original_name || file.filename,
        url: file.file_url, // URL dari Supabase
        preview_url: isImage ? file.file_url : null, // Gunakan URL Supabase untuk preview
        created_at: file.created_at,
        type: 'file',
        file_type: file.file_type
      };
    });

    res.json({
      success: true,
      data: {
        files,
        folders: foldersResult.rows.map(folder => ({
          id: folder.id,
          name: folder.name,
          type: 'folder',
          created_at: folder.created_at
        }))
      }
    });

  } catch (error) {
    console.error('Error in GET /api/files:', error);
    res.status(500).json({
      success: false,
      error: `Gagal mengambil data: ${error.message}`
    });
  }
});

// POST endpoint untuk membuat folder
router.post('/folders', async (req, res) => {
  try {
    const { name, path: folderPath = '' } = req.body;
    const userId = req.user.userId;

    console.log('Creating folder:', { name, folderPath, userId });

    // Validasi nama folder
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Nama folder tidak boleh kosong'
      });
    }

    // Generate storage path
    const storagePath = `${userId}${folderPath ? '/' + folderPath : ''}/${name}/`.replace(/\/+/g, '/');
    
    console.log('Storage path:', storagePath);

    // Buat folder dengan file .keep
    const { data, error: uploadError } = await supabase.storage
      .from('files')
      .upload(`${storagePath}.keep`, new Uint8Array(0), {
        contentType: 'text/plain',
        upsert: true // Ubah ke true untuk menimpa jika sudah ada
      });

    console.log('Supabase upload response:', { data, error: uploadError });

    if (uploadError && uploadError.message !== 'The resource already exists') {
      console.error('Supabase folder creation error:', uploadError);
      throw uploadError;
    }

    // Simpan ke database
    const result = await db.query(
      `INSERT INTO folders (
        name, 
        path, 
        user_id,
        created_at
      ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
      RETURNING id, name, path, created_at`,
      [name, folderPath, userId]
    );

    res.json({
      success: true,
      data: {
        folder: {
          id: result.rows[0].id,
          name: result.rows[0].name,
          type: 'folder',
          created_at: result.rows[0].created_at,
          path: folderPath
        }
      }
    });

  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Gagal membuat folder'
    });
  }
});

// POST /api/files/upload dengan error handling yang lebih baik
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Tidak ada file yang diunggah'
      });
    }

    // Validasi ukuran file
    if (req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'Ukuran file terlalu besar (maksimal 10MB)'
      });
    }

    const userId = req.user.userId;
    const uploadPath = req.body.path || '';
    
    console.log('Upload request:', {
      userId,
      path: uploadPath,
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer ? 'Buffer exists' : 'No buffer'
      }
    });

    // Generate unique filename
    const fileName = `${Date.now()}-${req.file.originalname}`;
    const filePath = `${userId}${uploadPath ? '/' + uploadPath : ''}/${fileName}`.replace(/\/+/g, '/');

    // Upload ke Supabase Storage dengan buffer dari file
    const { data, error: uploadError } = await supabase.storage
      .from('files')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: 'half',
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      throw uploadError;
    }

    console.log('Upload success:', data);

    // Dapatkan URL publik
    const { data: { publicUrl } } = supabase.storage
      .from('files')
      .getPublicUrl(filePath);

    console.log('Public URL:', publicUrl);

    // Simpan ke database
    const result = await db.query(
      `INSERT INTO files (
        filename,
        original_name,
        path,
        file_url,
        file_type,
        file_size,
        user_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        fileName,
        req.file.originalname,
        uploadPath,
        publicUrl,
        req.file.mimetype,
        req.file.size,
        userId
      ]
    );

    console.log('File saved to database:', result.rows[0]);

    res.json({
      success: true,
      file: {
        ...result.rows[0],
        type: 'file'
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    // Tangani error multer
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        error: 'Error upload file: ' + error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Gagal mengupload file: ' + error.message
    });
  }
});

// Endpoint untuk download file
router.get('/download/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;
    
    // Ambil informasi file dari database
    const result = await db.query(
      'SELECT filename, original_name, path FROM files WHERE id = $1 AND user_id = $2',
      [fileId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'File tidak ditemukan' 
      });
    }

    const file = result.rows[0];
    const filePath = path.join(
      __dirname, 
      '../uploads',
      userId.toString(),
      file.path || '',
      file.filename
    );

    console.log('Downloading file from:', filePath);

    // Periksa file exists
    if (!fsSync.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'File tidak ditemukan di server' 
      });
    }

    // Download file
    res.download(filePath, file.original_name, (err) => {
      if (err) {
        console.error('Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({ 
            success: false, 
            error: 'Gagal mengunduh file' 
          });
        }
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: 'Gagal mengunduh file: ' + error.message 
      });
    }
  }
});

// Endpoint delete file
router.delete('/files/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const userId = req.user.userId;

    // Ambil info file
    const fileResult = await db.query(
      'SELECT filename, path, original_name FROM files WHERE id = $1 AND user_id = $2',
      [fileId, userId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'File tidak ditemukan' 
      });
    }

    const { filename, path: filePath, original_name } = fileResult.rows[0];
    const fullPath = path.join(
      __dirname, 
      '../uploads',
      userId.toString(),
      filePath || '',
      filename
    );

    console.log('Deleting file:', fullPath);

    // Hapus file fisik
    if (fsSync.existsSync(fullPath)) {
      await fs.unlink(fullPath);
    }

    // Hapus dari database
    await db.query(
      'DELETE FROM files WHERE id = $1 AND user_id = $2',
      [fileId, userId]
    );

    res.json({ 
      success: true,
      message: `File ${original_name} berhasil dihapus`
    });

  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Gagal menghapus file: ' + error.message 
    });
  }
});

// Endpoint hapus folder
router.delete('/folders/:id', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    const folderId = req.params.id;
    const userId = req.user.userId;

    console.log('Deleting folder:', { folderId, userId });

    // Cek apakah folder ada dan milik user yang benar
    const folderCheck = await client.query(
      'SELECT * FROM folders WHERE id = $1 AND user_id = $2',
      [folderId, userId]
    );

    if (folderCheck.rows.length === 0) {
      throw new Error('Folder tidak ditemukan');
    }

    const folder = folderCheck.rows[0];
    const folderPath = `${userId}${folder.path ? '/' + folder.path : ''}/${folder.name}/`.replace(/\/+/g, '/');

    // Hapus semua file dalam folder dari Supabase Storage
    const { data: folderContents, error: listError } = await supabase.storage
      .from('files')
      .list(folderPath);

    if (listError) throw listError;

    if (folderContents && folderContents.length > 0) {
      const filesToDelete = folderContents.map(file => `${folderPath}${file.name}`);
      const { error: deleteError } = await supabase.storage
        .from('files')
        .remove(filesToDelete);

      if (deleteError) throw deleteError;
    }

    // Hapus folder dari Supabase Storage
    const { error: deleteFolderError } = await supabase.storage
      .from('files')
      .remove([`${folderPath}.keep`]);

    if (deleteFolderError && deleteFolderError.message !== 'Object not found') {
      throw deleteFolderError;
    }

    // Hapus records file dari database
    await client.query(
      'DELETE FROM files WHERE parent_folder_id = $1 AND user_id = $2',
      [folderId, userId]
    );
    
    // Hapus folder dari database
    await client.query(
      'DELETE FROM folders WHERE id = $1 AND user_id = $2',
      [folderId, userId]
    );

    await client.query('COMMIT');
    res.json({ 
      success: true,
      message: 'Folder berhasil dihapus'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete folder error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Gagal menghapus folder' 
    });
  } finally {
    client.release();
  }
});

// Endpoint rename yang simpel dan pasti bekerja
router.put('/rename/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { newName } = req.body;
    const userId = req.user.userId;

    // Log untuk debugging
    console.log('Rename request:', { type, id, newName, userId });

    let query;
    if (type === 'folder') {
      query = 'UPDATE folders SET name = $1 WHERE id = $2 AND user_id = $3';
    } else {
      query = 'UPDATE files SET original_name = $1 WHERE id = $2 AND user_id = $3';
    }

    await db.query(query, [newName, id, userId]);
    
    res.json({ success: true });

  } catch (error) {
    console.error('Error renaming:', error);
    res.status(500).json({ success: false, message: 'Gagal mengubah nama' });
  }
});

module.exports = router;
