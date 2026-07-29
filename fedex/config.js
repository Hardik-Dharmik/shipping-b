const isProduction = process.env.NODE_ENV === 'production';

const fedexConfig = {
  baseUrl: (process.env.FEDEX_API_BASE_URL || (
    isProduction ? 'https://apis.fedex.com' : 'https://apis-sandbox.fedex.com'
  )).replace(/\/$/, ''),
  clientId: process.env.FEDEX_CLIENT_ID,
  clientSecret: process.env.FEDEX_CLIENT_SECRET,
  accountNumber: process.env.FEDEX_ACCOUNT_NUMBER,
  grantType: process.env.FEDEX_GRANT_TYPE || 'client_credentials',
  childKey: process.env.FEDEX_CHILD_KEY,
  childSecret: process.env.FEDEX_CHILD_SECRET,
  defaultServiceType: process.env.FEDEX_DEFAULT_SERVICE_TYPE || 'FEDEX_INTERNATIONAL_PRIORITY',
  requestTimeoutMs: Number(process.env.FEDEX_REQUEST_TIMEOUT_MS || 10000)
};

function assertFedExConfigured() {
  const missing = ['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'FEDEX_ACCOUNT_NUMBER']
    .filter((name) => !process.env[name]);

  if (missing.length) {
    const error = new Error(`FedEx is not configured. Missing: ${missing.join(', ')}`);
    error.code = 'FEDEX_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
}

module.exports = { fedexConfig, assertFedExConfigured };
