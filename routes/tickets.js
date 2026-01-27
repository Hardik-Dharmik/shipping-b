const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({
      success: false,
      error: 'Access denied: Admin role required'
    });
  }
};

// Create a new ticket
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { awb_number, category, subcategory } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role; 

    if (!awb_number || !category || !subcategory) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: awb_number, category, subcategory'
      });
    }

    /* 1️⃣ Fetch order using AWB (server-side only) */
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('id, user_id')
      .eq('awb_number', awb_number)
      .single();

    if (orderError || !order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found for this AWB number'
      });
    }

    /* 2️⃣ Ownership check */
    if (userRole !== 'admin' && order.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'You are not authorized to create a ticket for this order'
      });
    }

    /* 3️⃣ Create ticket WITHOUT messages */
    const { data, error } = await supabaseAdmin
      .from('tickets')
      .insert({
        awb_number,
        order_id: order.id, // derived securely
        user_id: order.user_id,
        category,
        subcategory,
        status: 'open',
        messages: []        // ✅ empty conversation
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          error: 'A ticket already exists for this AWB number'
        });
      }
      throw error;
    }

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      data
    });

  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Get tickets for the authenticated user
router.get('/my-tickets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role; // 'user' | 'admin'

    let query = supabaseAdmin
      .from('tickets')
      .select(`
        id,
        awb_number,
        order_id,
        user_id,
        category,
        subcategory,
        status,
        created_at,
        updated_at,
        unread_admin_count,
        unread_user_count,
        users (
          name
        )
      `)
      .order('created_at', { ascending: false });

    // Restrict only for non-admin
    if (userRole !== 'admin') {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw error;

    // 🔁 Flatten username for frontend convenience
    const formattedData = data.map(ticket => ({
      ...ticket,
      username: ticket.users?.name || null,
      users: undefined // remove nested object
    }));

    res.json({
      success: true,
      data: formattedData
    });

  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get messages of a specific ticket
router.get('/:ticketId/messages', authenticateToken, async (req, res) => {
    try {
      const { ticketId } = req.params;
      const userId = req.user.id;
const role = req.user.role;

      // Fetch ticket messages with ownership check
      let query = supabaseAdmin
        .from('tickets')
        .select('messages')
        .eq('id', ticketId);

      const { data, error } = await query.single();

      if (error || !data) {
        return res.status(404).json({
          success: false,
          error: 'Ticket not found or access denied'
        });
      }

      const resetColumn =
  role === 'admin'
    ? 'unread_admin_count'
    : 'unread_user_count';

await supabaseAdmin
  .from('tickets')
  .update({ [resetColumn]: 0 })
  .eq('id', ticketId);

      res.json({
        success: true,
        messages: data.messages || []
      });

    } catch (error) {
      console.error('Get ticket messages error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// Post message to a specific ticket
router.post(
  '/:ticketId/messages',
  authenticateToken,
  upload.single('file'),
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { message } = req.body;
      const file = req.file;

      const userId = req.user.id;
      const userRole = req.user.role; // 'user' | 'admin'

      if (!message && !file) {
        return res.status(400).json({
          success: false,
          error: 'Message or file is required'
        });
      }

      // 1️⃣ Fetch ticket & verify access
      let query = supabaseAdmin
        .from('tickets')
        .select('id, status, messages')
        .eq('id', ticketId);

      if (userRole !== 'admin') {
        query = query.eq('user_id', userId);
      }

      const { data: ticket, error: ticketError } = await query.single();

      if (ticketError || !ticket) {
        return res.status(404).json({
          success: false,
          error: 'Ticket not found or access denied'
        });
      }

      if (ticket.status === 'closed') {
        return res.status(400).json({
          success: false,
          error: 'Ticket is closed'
        });
      }

      // 2️⃣ Upload file (if present)
      let fileUrl = null;
      let fileName = null;
      let fileType = null;

      if (file) {
        const filePath = `${ticketId}/${Date.now()}_${file.originalname}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from('ticket-attachments')
          .upload(filePath, file.buffer, {
            contentType: file.mimetype
          });

        if (uploadError) {
          return res.status(500).json({
            success: false,
            error: 'File upload failed'
          });
        }

        const { data } = supabaseAdmin.storage
          .from('ticket-attachments')
          .getPublicUrl(filePath);

        fileUrl = data.publicUrl;
        fileName = file.originalname;
        fileType = file.mimetype;
      }

      // 3️⃣ Create message object
      const messageObj = {
        id: crypto.randomUUID(),
        sender_id: userId,
        sender_role: userRole,
        message: message || null,
        file_url: fileUrl,
        file_name: fileName,
        file_type: fileType,
        created_at: new Date().toISOString()
      };

      // 4️⃣ Append message to JSONB array
      const updatedMessages = [...ticket.messages, messageObj];

      const { error: updateError } = await supabaseAdmin
        .from('tickets')
        .update({ messages: updatedMessages })
        .eq('id', ticketId);

      if (updateError) throw updateError;

      const unreadColumn =
  userRole === 'user'
    ? 'unread_admin_count'
    : 'unread_user_count';

// fetch current count
const { data: currentTicket, error: countErr } = await supabaseAdmin
  .from('tickets')
  .select(unreadColumn)
  .eq('id', ticketId)
  .single();

if (countErr) throw countErr;

// increment safely
await supabaseAdmin
  .from('tickets')
  .update({
    [unreadColumn]: (currentTicket[unreadColumn] || 0) + 1
  })
  .eq('id', ticketId);



      res.json({
        success: true,
        message: messageObj
      });

    } catch (error) {
      console.error('Post ticket message error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// Get all tickets (Admin only)
router.get('/all', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tickets')
      .select(`
        *,
        users:user_id (name, email, company_name)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Get all tickets error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
