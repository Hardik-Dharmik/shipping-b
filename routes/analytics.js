const express = require('express');
const { supabaseAdmin } = require('../supabase');
const { requireAdminAccess } = require('../middleware/adminAccess');

const router = express.Router();
router.use(requireAdminAccess('home'));

router.get('/', async (req, res) => {
  try {
    const countRows = (table) => supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    const countKyc = (status) => countRows('users').eq('kyc_required', true).eq('kyc_status', status);
    const metrics = [
      ['totalOrders', countRows('orders')],
      ['totalCustomers', countRows('customers')],
      ['pendingKyc', countKyc('pending')],
      ['completedKyc', countKyc('completed')],
      ['notStartedKyc', countKyc('not_started')]
    ];
    const results = await Promise.all(metrics.map(async ([key, query]) => {
      const { count, error } = await query;
      if (error) throw error;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid count for ${key}`);
      return [key, count];
    }));
    return res.json({ success: true, data: Object.fromEntries(results) });
  } catch (error) {
    console.error('Analytics error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load analytics' });
  }
});

module.exports = router;
