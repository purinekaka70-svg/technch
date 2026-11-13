import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudPayReceipt } from '../lib/cloudpay-fields.js';

test('reads the documented top-level CloudPay M-Pesa receipt', () => {
  assert.equal(cloudPayReceipt({ receipt: 'sgh3xyz890' }), 'SGH3XYZ890');
});

test('reads receipt values from wrapped and alternate provider status payloads', () => {
  assert.equal(cloudPayReceipt({ data: { transaction: { mpesaReceiptNumber: 'QJG7A5BKLN' } } }), 'QJG7A5BKLN');
  assert.equal(cloudPayReceipt({ mpesa_receipt_number: 'ABC123XYZ' }), 'ABC123XYZ');
  assert.equal(cloudPayReceipt({}), null);
});
