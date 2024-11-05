const bcrypt = require('bcrypt');
const { pool } = require('./db');

async function createInitialAdmin() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check if admin exists
    const checkResult = await client.query(
      'SELECT * FROM users WHERE email = $1',
      ['admin@example.com']
    );

    if (checkResult.rows.length > 0) {
      console.log('Admin already exists');
      await client.query('COMMIT');
      return;
    }

    // Create admin
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (username, email, password, role) 
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'admin@example.com', hashedPassword, 'admin']
    );

    await client.query('COMMIT');
    console.log('Admin created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating admin:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run with proper error handling
createInitialAdmin()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });