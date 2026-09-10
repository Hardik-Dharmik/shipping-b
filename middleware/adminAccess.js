const { authenticateToken } = require('../routes/auth');
const { hasPageAccess } = require('../utils/permissions');

const requireAdminAccess = (page) => (req, res, next) => {
  const authorize = () => {
    if (req.user?.role === 'admin' || (page && hasPageAccess(req.user, page))) return next();
    return res.status(403).json({ success: false, error: 'Access denied: Admin role or page permission required' });
  };
  // Keep the existing server-to-server admin token supported.
  if (!req.headers.authorization && process.env.ADMIN_TOKEN && req.headers['x-admin-token'] === process.env.ADMIN_TOKEN) return next();
  if (req.user) return authorize();
  return authenticateToken(req, res, authorize);
};
module.exports = { requireAdminAccess };
