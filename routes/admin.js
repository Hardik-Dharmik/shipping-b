const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../supabase');

// Middleware to check admin access
// Accepts both JWT token (from login) and admin token (for direct admin access)
const isAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const { data: user, error } = await supabaseAdmin
          .from('users')
          .select('id, name, email, organization_code, organization_role, kyc_required, role, kyc_status')
          .eq('id', decoded.userId)
          .single();

        if (!error && user && user.role === 'admin') {
          req.user = user;
          return next();
        }

        if (!error && user && user.role !== 'admin') {
          return res.status(403).json({
            success: false,
            error: 'Access denied: Admin role required'
          });
        }
      } catch (jwtError) {
        // JWT verification failed, try admin token below
      }
    }

    const adminToken = req.headers['x-admin-token'];
    if (adminToken && adminToken === process.env.ADMIN_TOKEN) {
      return next();
    }

    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Admin access required. Provide Authorization Bearer token (from login with admin role) or x-admin-token header.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get all users with optional filters
router.get('/users', isAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const role = String(req.query.role || '').trim();
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

    const allowedSortFields = new Set([
      'created_at',
      'updated_at',
      'name',
      'email',
      'company_name',
      'role',
      'kyc_status'
    ]);
    const allowedSortOrders = new Set(['asc', 'desc']);

    if (!allowedSortFields.has(sortBy)) {
      return res.status(400).json({
        success: false,
        error: 'sortBy must be one of: created_at, updated_at, name, email, company_name, role, kyc_status'
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
      .from('users')
      .select('id, name, email, company_name, organization_code, organization_role, kyc_required, role, file_url, file_name, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, created_at, updated_at', {
        count: 'exact'
      });

    if (search) {
      const escapedSearch = search.replace(/[%_,]/g, '\\$&');
      query = query.or(
        `name.ilike.%${escapedSearch}%,email.ilike.%${escapedSearch}%,company_name.ilike.%${escapedSearch}%`
      );
    }

    if (role) {
      query = query.eq('role', role);
    }

    if (fromDate) {
      query = query.gte('created_at', new Date(fromDate).toISOString());
    }

    if (toDate) {
      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);
      query = query.lte('created_at', endOfDay.toISOString());
    }

    const { data, count, error } = await query
      .order(sortBy, { ascending: sortOrder === 'asc' })
      .range(from, to);

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    const total = Number.isFinite(count) ? count : 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);

    res.json({
      success: true,
      count: data.length,
      users: data,
      pagination: {
        page,
        limit: safeLimit,
        search,
        filters: {
          role,
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all users with their order counts
router.get('/users-with-order-count', isAdmin, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('users')
      .select('id, name, email, company_name, organization_code, organization_role, kyc_required, role, kyc_status, created_at, updated_at, orders(count)');

    query = query.neq('role', 'admin');

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    const users = (data || []).map((user) => {
      const ordersCount = Array.isArray(user.orders) && user.orders[0] ? user.orders[0].count : 0;
      const { orders, ...rest } = user;
      return {
        ...rest,
        orders_count: ordersCount ?? 0
      };
    });

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single user by ID
router.get('/users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, company_name, organization_code, organization_role, kyc_required, role, file_url, file_name, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, created_at, updated_at')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user: data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.isAdmin = isAdmin;
