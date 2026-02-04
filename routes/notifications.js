const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

// Get notifications for authenticated user (polling)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit } = req.query;

    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const limitNum = parseInt(limit, 10);
    if (!Number.isNaN(limitNum) && limitNum > 0) {
      query = query.limit(limitNum);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = router;
