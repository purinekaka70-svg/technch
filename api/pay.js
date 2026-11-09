// Compatibility route used by the browser checkout. Keep the established
// payments handler so portal verification, billing, and hotspot activation
// continue to use the same trusted flow.
export { default } from './payments/initiate.js';
