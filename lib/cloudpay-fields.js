export function cloudPayReceipt(payload = {}) {
  const sources = [payload, payload.data, payload.data?.payment, payload.data?.transaction, payload.payment, payload.transaction].filter(Boolean);
  for (const source of sources) {
    const value = source.receipt || source.mpesaReceipt || source.mpesaReceiptNumber || source.mpesa_receipt_number || source.receiptNumber;
    if (value != null && String(value).trim()) return String(value).trim().toUpperCase();
  }
  return null;
}
