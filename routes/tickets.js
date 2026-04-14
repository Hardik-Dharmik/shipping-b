const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const generateTicketNumber = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

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
    let data = null;
    let lastError = null;
    let ticketNumber = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      ticketNumber = generateTicketNumber();
      const { data: inserted, error } = await supabaseAdmin
        .from('tickets')
        .insert({
          awb_number,
          order_id: order.id, // derived securely
          user_id: order.user_id,
          created_by_id: userId,
          created_by_role: userRole,
          category,
          subcategory,
          status: 'open',
          messages: [],        // ✅ empty conversation
          ticket_number: ticketNumber
        })
        .select()
        .single();

      if (!error) {
        data = inserted;
        lastError = null;
        break;
      }

      if (error.code !== '23505') {
        throw error;
      }

      lastError = error;
    }

    if (!data) {
      throw lastError || new Error('Failed to generate unique ticket number');
    }

    if (userRole === 'admin') {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: order.user_id,
          type: 'ticket_created',
          title: 'New ticket created',
          body: `Ticket ${data.ticket_number} created for AWB ${awb_number}.`,
          data: {
            ticket_id: data.id,
            awb_number,
            ticket_number: data.ticket_number
          }
        });
    } else {
      const { data: admins, error: adminError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role', 'admin')
        .eq('approval_status', 'approved');

      if (!adminError && admins && admins.length > 0) {
        const rows = admins.map((admin) => ({
          user_id: admin.id,
          type: 'ticket_created',
          title: 'New ticket created',
          body: `Ticket ${data.ticket_number} created for AWB ${awb_number}.`,
          data: {
            ticket_id: data.id,
            awb_number,
            ticket_number: data.ticket_number
          }
        }));
        await supabaseAdmin.from('notifications').insert(rows);
      }
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

    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const category = String(req.query.category || '').trim();
    const user = String(req.query.user || '').trim();
    const awbNumber = String(req.query.awb || '').trim();
    const ticketNumber = String(req.query.ticket || '').trim();
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate = String(req.query.toDate || '').trim();
    const sortBy = String(req.query.sortBy || 'created_at').trim();
    const sortOrder = String(req.query.sortOrder || 'desc').trim().toLowerCase();
    const parsePositiveInteger = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return NaN;

      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) ? parsed : NaN;
    };

    const page = parsePositiveInteger(req.query.page, 1);
    const limit = parsePositiveInteger(req.query.limit, 10);

    if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1) {
      return res.status(400).json({
        success: false,
        error: 'page and limit must be positive integers'
      });
    }

    const isValidDate = (value) => !value || !Number.isNaN(Date.parse(value));

    if (!isValidDate(fromDate) || !isValidDate(toDate)) {
      return res.status(400).json({
        success: false,
        error: 'fromDate and toDate must be valid dates'
      });
    }

    const allowedSortFields = new Set(['created_at', 'status']);
    const allowedSortOrders = new Set(['asc', 'desc']);

    if (!allowedSortFields.has(sortBy)) {
      return res.status(400).json({
        success: false,
        error: 'sortBy must be one of: created_at, status'
      });
    }

    if (!allowedSortOrders.has(sortOrder)) {
      return res.status(400).json({
        success: false,
        error: 'sortOrder must be either asc or desc'
      });
    }

    const safeLimit = Math.min(limit, 100);
    const from = (page - 1) * safeLimit;
    const to = from + safeLimit - 1;

    let query = supabaseAdmin
      .from('tickets')
      .select(`
        id,
        ticket_number,
        awb_number,
        order_id,
        user_id,
        category,
        subcategory,
        status,
        created_by_id,
        created_by_role,
        created_at,
        updated_at,
        unread_admin_count,
        unread_user_count,
        users:users!tickets_user_id_fkey (
          name
        )
      `);

    if (search) {
      const escapedSearch = search.replace(/[%_,]/g, '\\$&');
      query = query.or(
        `awb_number.ilike.%${escapedSearch}%,status.ilike.%${escapedSearch}%,category.ilike.%${escapedSearch}%,subcategory.ilike.%${escapedSearch}%,ticket_number.ilike.%${escapedSearch}%`
      );
    }

    if (status) {
      query = query.ilike('status', status);
    }

    if(category) {
      query = query.ilike('category', category);
    }

    if (fromDate) {
      query = query.gte('created_at', new Date(fromDate).toISOString());
    }

    if (toDate) {
      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);
      query = query.lte('created_at', endOfDay.toISOString());
    }
    // Restrict only for non-admin
    if (userRole !== 'admin') {
      query = query.eq('user_id', userId);
    }

    const { data, count, error } = await query
      .order(sortBy, { ascending: sortOrder === 'asc' })
      .range(from, to);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }


    // 🔁 Flatten username for frontend convenience
    const formattedData = data.map(ticket => ({
      ...ticket,
      username: ticket.users?.name || null,
      users: undefined // remove nested object
    }));

    const total = Number.isFinite(count) ? count : 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);


    res.json({
      success: true,
      data: formattedData,
      pagination: {
        page,
        limit: safeLimit,
        search,
        filters: {
          status,
          category,
          fromDate,
          toDate
        },
        sorting: {
          sortBy,
          sortOrder
        },
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
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
        .select('id, status, messages, user_id, awb_number')
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

      // Notify the other party only
      if (userRole === 'admin') {
        await supabaseAdmin
          .from('notifications')
          .insert({
            user_id: ticket.user_id,
            type: 'ticket_message',
            title: 'New ticket reply',
            body: `New message for ticket ${ticketId}.`,
            data: {
              ticket_id: ticketId,
              awb_number: ticket.awb_number || null
            }
          });
      } else {
        const { data: admins, error: adminError } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('role', 'admin')
          .eq('approval_status', 'approved');

        if (!adminError && admins && admins.length > 0) {
          const rows = admins.map((admin) => ({
            user_id: admin.id,
            type: 'ticket_message',
            title: 'New ticket message',
            body: `New message from user for ticket ${ticketId}.`,
            data: {
              ticket_id: ticketId,
              awb_number: ticket.awb_number || null
            }
          }));
          await supabaseAdmin.from('notifications').insert(rows);
        }
      }

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
        users:users!tickets_user_id_fkey (name, email, company_name)
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
