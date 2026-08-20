const isProduction = process.env.NODE_ENV === 'production';

const upsConfig = {
  baseUrl: (process.env.UPS_API_BASE_URL || (isProduction ? 'https://api.ups.com' : 'https://sandbox-api.ups.com')).replace(/\/$/, ''),
  apiKey: process.env.UPS_API_KEY,
  accountNumber: process.env.UPS_ACCOUNT_NUMBER,
  defaultServiceType: process.env.UPS_DEFAULT_SERVICE_TYPE || 'UPS_EXPRESS',
  logPayloads: process.env.UPS_LOG_PAYLOADS !== 'false',
  requestTimeoutMs: Number(process.env.UPS_REQUEST_TIMEOUT_MS || 10000)
};

function assertUPSConfigured() {
  const missing = ['UPS_API_KEY', 'UPS_ACCOUNT_NUMBER'].filter((name) => !process.env[name]);
  if (missing.length) {
    const error = new Error(`UPS is not configured. Missing: ${missing.join(', ')}`);
    error.code = 'UPS_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
}

module.exports = { upsConfig, assertUPSConfigured };
