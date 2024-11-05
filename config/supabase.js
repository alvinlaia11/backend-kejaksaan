const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// Debug log untuk memeriksa credentials
console.log('Supabase credentials:', {
  url: supabaseUrl,
  keyExists: !!supabaseKey
});

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  throw new Error('Missing required environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_KEY');
}

// Pastikan URL valid sebelum membuat client
try {
  new URL(supabaseUrl); // Validasi URL
} catch (error) {
  console.error('Invalid Supabase URL:', supabaseUrl);
  throw new Error('Invalid SUPABASE_URL format');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Test koneksi
supabase.auth.getSession()
  .then(() => console.log('Supabase connection successful'))
  .catch(err => console.error('Supabase connection error:', err));

module.exports = supabase; 