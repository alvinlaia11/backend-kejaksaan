const express = require('express');
const pool = require('../db');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

// POST /api/cases
router.post('/cases', authenticateToken, async (req, res) => {
  try {
    console.log('Received request body:', req.body);
    
    const { 
      title, 
      date, 
      description, 
      type, 
      parties,
      witnesses,
      prosecutor
    } = req.body;

    // Log setiap field
    console.log('Data yang diterima:', {
      title,
      date,
      description,
      type,
      parties,
      witnesses,
      prosecutor
    });

    // Validasi input
    if (!title || !date || !type) {
      console.log('Validation failed:', { title, date, type });
      return res.status(400).json({ 
        error: 'Judul, tanggal, dan tipe kasus harus diisi' 
      });
    }

    // Pastikan format tanggal benar
    const formattedDate = new Date(date).toISOString();

    // Pastikan witnesses dan prosecutor tidak null atau EMPTY
    const witnessesValue = witnesses === null || witnesses === 'EMPTY' ? '' : witnesses;
    const prosecutorValue = prosecutor === null || prosecutor === 'EMPTY' ? '' : prosecutor;

    // Log nilai witnesses dan prosecutor sebelum query
    console.log('Data yang akan disimpan:', {
      witnesses: witnessesValue,
      prosecutor: prosecutorValue
    });

    const query = `
      INSERT INTO cases (
        title, date, description, type, parties, witnesses, prosecutor
      ) VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *
    `;

    const values = [
      title, 
      formattedDate, 
      description || '', 
      type, 
      parties || '',
      witnessesValue,
      prosecutorValue
    ];

    console.log('Query values:', values);

    const result = await pool.query(query, values);
    
    // Log hasil query
    console.log('Data yang tersimpan:', result.rows[0]);

    // Verifikasi data tersimpan
    const verifyQuery = `
      SELECT * FROM cases WHERE id = $1
    `;
    const verifyResult = await pool.query(verifyQuery, [result.rows[0].id]);
    console.log('Verification data:', verifyResult.rows[0]);

    return res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error('Error detail:', err);
    return res.status(500).json({ 
      error: 'Gagal menambahkan kasus: ' + (err.message || 'Unknown error') 
    });
  }
});

// GET /api/cases
router.get('/cases', authenticateToken, async (req, res) => {
  try {
    const { type } = req.query;
    let query = `
      SELECT 
        id, 
        title, 
        date, 
        description, 
        type, 
        parties, 
        COALESCE(witnesses, '') as witnesses,
        COALESCE(prosecutor, '') as prosecutor
      FROM cases
    `;
    
    let queryParams = [];
    let queryValues = [];
    
    if (type) {
      queryParams.push(`type = $${queryParams.length + 1}`);
      queryValues.push(type);
    }
    
    if (queryParams.length > 0) {
      query += ` WHERE ${queryParams.join(' AND ')}`;
    }
    
    query += ` ORDER BY date DESC`;
    
    console.log('Executing query:', {
      text: query,
      values: queryValues
    });
    
    const result = await pool.query(query, queryValues);
    
    // Log hasil query untuk debugging
    console.log('Query result:', result.rows);
    
    return res.status(200).json(result.rows);
    
  } catch (err) {
    console.error('Error in GET /cases:', err);
    return res.status(500).json({ 
      error: 'Gagal mengambil data kasus: ' + (err.message || 'Unknown error')
    });
  }
});

// PUT /api/cases/:id
router.put('/cases/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      date, 
      description, 
      type, 
      parties,
      witnesses,
      prosecutor 
    } = req.body;

    // Validasi input
    if (!title || !date) {
      return res.status(400).json({ 
        error: 'Judul dan tanggal harus diisi' 
      });
    }

    // Pastikan format tanggal benar
    const formattedDate = new Date(date).toISOString();

    // Log data yang akan diupdate
    console.log('Updating case:', {
      id,
      title,
      date: formattedDate,
      description,
      type,
      parties,
      witnesses,
      prosecutor
    });

    const query = `
      UPDATE cases 
      SET title = $1, 
          date = $2, 
          description = $3, 
          type = $4, 
          parties = $5,
          witnesses = $6,
          prosecutor = $7,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8 
      RETURNING *
    `;

    const values = [
      title,
      formattedDate,
      description || '',
      type,
      parties || '',
      witnesses || '', // Pastikan tidak null
      prosecutor || '', // Pastikan tidak null
      id
    ];

    console.log('Query values:', values);

    const result = await pool.query(query, values);
    console.log('Updated case:', result.rows[0]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Kasus tidak ditemukan' 
      });
    }

    return res.json(result.rows[0]);

  } catch (err) {
    console.error('Error in PUT /cases/:id:', err);
    return res.status(500).json({ 
      error: 'Gagal mengupdate kasus: ' + (err.message || 'Unknown error') 
    });
  }
});

// GET /api/cases/:id
router.get('/cases/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        id, 
        title, 
        date, 
        description, 
        type, 
        parties,
        COALESCE(witnesses, '') as witnesses,
        COALESCE(prosecutor, '') as prosecutor
      FROM cases
      WHERE id = $1
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Kasus tidak ditemukan' 
      });
    }
    
    // Log hasil query untuk debugging
    console.log('Query result for ID:', result.rows[0]);
    
    return res.json(result.rows[0]);
    
  } catch (err) {
    console.error('Error in GET /cases/:id:', err);
    return res.status(500).json({ 
      error: 'Gagal mengambil detail kasus: ' + (err.message || 'Unknown error')
    });
  }
});

module.exports = router; 