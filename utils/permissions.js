const ADMIN_PAGES = Object.freeze([
  { key: 'customers', label: 'Customers' },
  { key: 'rate_calculator', label: 'Rate calculator' },
  { key: 'create_order', label: 'Create order' },
  { key: 'users', label: 'Users' },
  { key: 'home', label: 'Home' },
  { key: 'user_orders', label: 'User Orders' },
  { key: 'kyc_requests', label: 'KYC Requests' },
  { key: 'billing', label: 'Billing' },
  { key: 'tickets', label: 'Tickets' }
]);
const PAGE_KEYS = ADMIN_PAGES.map(page => page.key);
const hasPageAccess = (user, page) => user?.role === 'admin' ||
  (user?.role === 'employee' && PAGE_KEYS.includes(page) &&
    Array.isArray(user.page_permissions) && user.page_permissions.includes(page));
const effectivePermissions = user => user.role === 'admin' ? PAGE_KEYS :
  user.role === 'employee' ? PAGE_KEYS.filter(page => hasPageAccess(user, page)) : [];

// Shared helpers can be called by any of the pages listed for them.
function pagesForRequest(req) {
  const path = (req.originalUrl || '').split('?')[0];
  if (path.startsWith('/api/auth/')) return null;
  if (path.startsWith('/api/admin/users')) return ['users'];
  if (path === '/api/customers' || path === '/api/customers/') return ['customers'];
  if (path.startsWith('/api/customers/')) return ['customers', 'create_order'];
  if (path.startsWith('/api/shipping/orders')) return ['user_orders'];
  if (path.startsWith('/api/shipping/quote')) return ['rate_calculator', 'create_order'];
  if (path.startsWith('/api/shipping/rate-calculator')) return ['rate_calculator'];
  if (path.startsWith('/api/shipping/order')) return ['create_order'];
  if (path.startsWith('/api/shipping/pickups')) return ['user_orders'];
  if (path.startsWith('/api/kyc/')) return ['kyc_requests'];
  if (path.startsWith('/api/billing/')) return ['billing'];
  if (path.startsWith('/api/tickets/')) return ['tickets'];
  if (path.startsWith('/api/notifications')) return ['home'];
  if (/^\/api\/(address|box-details|contact-details|ai)(\/|$)/.test(path)) return ['create_order'];
  if (path.startsWith('/api/locations/')) return ['rate_calculator', 'create_order'];
  return []; // New endpoints deny employee access until explicitly mapped.
}
function employeePageGuard(req, res, next) {
  if (req.user?.role !== 'employee') return next();
  const pages = pagesForRequest(req);
  if (pages === null || pages.some(page => hasPageAccess(req.user, page))) return next();
  return res.status(403).json({ success: false, error: 'Access denied: Page permission required' });
}
module.exports = { ADMIN_PAGES, PAGE_KEYS, hasPageAccess, effectivePermissions, employeePageGuard };
