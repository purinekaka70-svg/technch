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
  const payment = cloudPayPayment(payload);
  return String(firstValue(
    payment.receipt,
    payment.mpesaReceiptNumber,
    payment.mpesa_receipt_number,
    payment.mpesaReceipt,
    payment.mpesa_receipt,
    payment.receiptNumber,
    payment.receipt_number
  ) || '').trim().toUpperCase();
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
