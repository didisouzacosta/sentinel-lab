// Teste de back-end: SDK oficial @sentry/node enviando para o Sentinel local.
import * as Sentry from '@sentry/node';

const DSN = process.env.SENTINEL_DSN;
if (!DSN) throw new Error('Defina SENTINEL_DSN');

Sentry.init({
	dsn: DSN,
	release: 'api-backend@2.0.0',
	environment: 'staging',
	tracesSampleRate: 1.0, // transações: o Sentinel deve ignorar sem quebrar
});

Sentry.setUser({ id: 'u-42', email: 'teste@example.com' });
Sentry.setTag('service', 'checkout-api');
Sentry.addBreadcrumb({ category: 'db', message: 'SELECT * FROM orders WHERE id = 991' });

function chargeCard(orderId) {
	throw new TypeError(
		`Cannot read properties of undefined (reading 'amount') for order ${orderId}`,
	);
}

for (const orderId of [991, 992, 993]) {
	try {
		chargeCard(orderId);
	} catch (e) {
		Sentry.captureException(e);
	}
}

Sentry.captureMessage('Fila de pagamentos acima de 1000 itens', 'warning');

await Sentry.startSpan({ name: 'POST /checkout', op: 'http.server' }, async () => {
	await new Promise((r) => setTimeout(r, 20));
});

const ok = await Sentry.flush(5000);
console.log('flush ok =', ok);
