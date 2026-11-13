const firstValue = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '');

export function cloudPayPayment(payload) {
  return payload?.data?.payment || payload?.data?.transaction || payload?.data || payload?.payment || payload?.transaction || payload || {};
}

export function cloudPayStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (['COMPLETED', 'SUCCESS', 'SUCCEEDED', 'PAID'].includes(status)) return 'COMPLETED';
  if (['CANCELLED', 'CANCELED', 'EXPIRED'].includes(status)) return 'CANCELLED';
  if (['FAILED', 'DECLINED', 'REJECTED'].includes(status)) return 'FAILED';
  return status;
}

export function cloudPayReceipt(payload) {
  return cloudPayReceipts(payload)[0] || '';
}

export function cloudPayReceipts(payload) {
  const receiptFields = new Set(['receipt', 'mpesareceipt', 'mpesareceiptnumber', 'receipt_number', 'receiptnumber', 'mpesa_receipt']);
  const receipts = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const [key, item] of Object.entries(value)) {
      if (receiptFields.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) && item != null && typeof item !== 'object') {
        const normalized = String(item).replace(/[^a-z0-9]/gi, '').toUpperCase();
        if (normalized) receipts.add(normalized);
      }
      if (item && typeof item === 'object') visit(item, depth + 1);
    }
  };
  visit(payload);
  return [...receipts];
}

export function normalizeCloudPayResult(payload, reference) {
  const payment = cloudPayPayment(payload);
  const status = cloudPayStatus(payment.status ?? payload?.status);
  const receipt = cloudPayReceipt(payment);
  return {
    ...payment,
    ...(reference ? { reference } : {}),
    status,
    ...(receipt ? { receipt } : {})
  };
}
