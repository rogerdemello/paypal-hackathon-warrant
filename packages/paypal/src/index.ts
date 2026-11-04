/**
 * @warrant/paypal: a typed PayPal REST client for the endpoints Warrant uses, and an in-process sandbox simulator that
 * speaks the same API. Sandbox only: the client refuses the live base URL.
 */
export * from './client';
export * from './errors';
export { mapCapture, mapDispute, mapOrder, mapRefund, mapWebhookEvent } from './mappers';
export * from './simulator';
export * from './types';
