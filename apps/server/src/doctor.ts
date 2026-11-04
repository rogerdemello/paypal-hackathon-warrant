import { ConfigError, loadConfig } from './config';
import { loadEnvFile } from './env';
import { systemClock } from './clock';
import { doctorPassed, runPayPalDoctor } from './paypal-doctor';
import { createPayPalGateway } from './services/paypal';

/** `pnpm paypal:doctor`: check the PayPal side of the configuration with a few harmless calls. */

loadEnvFile();
try {
  const config = loadConfig(process.env);
  const gateway = createPayPalGateway(config, systemClock);
  const runId = Date.now().toString(36);
  const checks = await runPayPalDoctor({
    client: gateway.client,
    environment: gateway.env,
    webhookId: config.paypal.webhookId ?? (gateway.env === 'simulator' ? gateway.webhookId : null),
    merchantId: config.paypal.merchantId,
    publicBaseUrl: config.publicBaseUrl,
    returnUrl: `${config.webOrigin}/checkout/return`,
    cancelUrl: `${config.webOrigin}/checkout/cancel`,
    runId,
  });
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.optional === true ? 'warn' : 'FAIL'}  ${c.name}: ${c.detail}`);
  const passed = doctorPassed(checks);
  console.log(passed ? '\nPayPal looks ready.' : '\nFix the FAIL lines above, then run this again.');
  process.exit(passed ? 0 : 1);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Cannot check: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
