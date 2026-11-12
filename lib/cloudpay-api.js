export const cloudPayBase = () => {
  const environment = String(process.env.CLOUDPAY_ENV || '').trim().toLowerCase();
  return environment === 'production'
    ? 'https://www.pay.cloud.or.ke/api'
    : environment === 'sandbox' ? 'https://www.pay.cloud.or.ke/sandbox/api' : null;
};

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;

export async function cloudPayToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (tokenRequest) return tokenRequest;
  const base = cloudPayBase();
  const key = process.env.CLOUDPAY_CONSUMER_KEY || '';
  const secret = process.env.CLOUDPAY_CONSUMER_SECRET || '';
  if (!base || !key || !secret) throw new Error('CloudPay is not configured');
  tokenRequest = (async () => {
    try {
      const response = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
        signal: AbortSignal.timeout(8000)
      });
      let result = {};
      try { result = await response.json(); } catch { /* report a safe provider error */ }
      const accessToken = result.access_token || result.data?.access_token;
      if (!response.ok) {
        const providerCode = result.errorCode || result.code;
        const detail = providerCode ? `: ${String(providerCode).slice(0, 80)}` : '';
        throw new Error(response.status === 401 || response.status === 403
          ? `CloudPay rejected the consumer credentials (HTTP ${response.status})${detail}`
          : `CloudPay OAuth failed (HTTP ${response.status})${detail}`);
      }
      if (!accessToken) throw new Error('CloudPay OAuth response did not include an access token');
      cachedToken = accessToken;
      tokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 3600) - 60) * 1000;
      return cachedToken;
    } finally { tokenRequest = null; }
  })();
  return tokenRequest;
}
