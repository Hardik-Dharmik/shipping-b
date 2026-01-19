const bcrypt = require('bcrypt');
const readline = require('readline');
const { supabaseAdmin } = require('../supabase');
require('dotenv').config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createAdmin() {
  try {
    console.log('=== Create Admin User ===\n');

    const name = await question('Enter admin name: ');
    const email = await question('Enter admin email: ');
    const password = await question('Enter admin password: ');
    const company_name = await question('Enter company name: ');

    if (!name || !email || !password || !company_name) {
      console.error('Error: All fields are required!');
      process.exit(1);
    }

    // Check if user already exists
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('email', email)
      .single();

    if (existingUser) {
      console.error(`Error: User with email ${email} already exists!`);
      process.exit(1);
    }

    // Hash password
    console.log('\nHashing password...');
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Create admin user with approved status and admin role
    console.log('Creating admin user...');
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .insert({
        name: name,
        email: email,
        password_hash: password_hash,
        company_name: company_name,
        role: 'admin', // Set role as admin
        approval_status: 'approved', // Admin is auto-approved
        file_url: null, // Admin doesn't need file
        file_name: null
      })
      .select('id, name, email, company_name, role, approval_status')
      .single();

    if (error) {
      console.error('Error creating admin user:', error.message);
      process.exit(1);
    }

    console.log('\n✅ Admin user created successfully!');
    console.log('\nUser details:');
    console.log(JSON.stringify(user, null, 2));
    console.log('\nYou can now use this email to login.');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

createAdmin();

