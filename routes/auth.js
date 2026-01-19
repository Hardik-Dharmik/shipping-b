const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../supabase');

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Middleware to verify JWT token (optional - for protected routes)
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
        // Get user from database
        const { data: user, error } = await supabaseAdmin
          .from('users')
          .select('id, name, email, company_name, role, approval_status')
          .eq('id', decoded.userId)
          .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    if (user.approval_status !== 'approved') {
      return res.status(403).json({
        success: false,
        error: 'Account pending approval'
      });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Login endpoint - works for both admin and regular users
router.post('/login', async (req, res) => {
  try {
    console.log(
      "Login endpoint hit",
      req.body
    );
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Get user from database
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, password_hash, company_name, role, approval_status, file_url, file_name')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password using bcrypt
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check if user is approved (both admin and regular users need to be approved)
    if (user.approval_status !== 'approved') {
      return res.status(403).json({
        success: false,
        error: 'Your account is pending approval. Please wait for admin approval.',
        approval_status: user.approval_status
      });
    }

    // Generate JWT token
    const token = generateToken(user.id);

    // Return success with user data and token
    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        company_name: user.company_name,
        role: user.role,
        approval_status: user.approval_status
      },
      token: token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Logout endpoint - works for both admin and regular users
// Note: Since JWT is stateless, logout is mainly client-side (token removal)
router.post('/logout', authenticateToken, (req, res) => {
  try {
    // JWT tokens are stateless, so server-side logout mainly involves:
    // 1. Client removing the token
    // 2. Server confirming the logout
    
    // Optional: You could maintain a blacklist of tokens here if needed
    // For now, we'll just confirm the logout
    
    res.json({
      success: true,
      message: 'Logout successful. Please clear your token on the client side.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get current user endpoint - works for both admin and regular users
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data: userProfile, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, company_name, role, approval_status, file_url, file_name, created_at, updated_at')
      .eq('id', req.user.id)
      .single();

    if (error || !userProfile) {
      return res.status(404).json({
        success: false,
        error: 'User profile not found'
      });
    }

    res.json({
      success: true,
      user: userProfile
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Verify token endpoint (optional - useful for checking if token is valid)
router.post('/verify-token', authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: 'Token is valid',
    user: req.user
  });
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;

