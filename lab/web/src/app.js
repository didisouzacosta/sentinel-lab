import * as Sentry from '@sentry/browser';

Sentry.init({
	// DSN vem da URL da página: index.html?dsn=http://<key>@127.0.0.1:8787/<id>
	dsn: new URLSearchParams(location.search).get('dsn'),
	release: 'web-frontend@1.0.0',
	environment: 'production',
});

class CartService {
	calculateTotal(items) {
		return items.reduce((sum, item) => sum + item.price.value * item.qty, 0);
	}
}

function onCheckoutClick() {
	const cart = new CartService();
	const total = cart.calculateTotal([{ price: { value: 10 }, qty: 1 }, { qty: 2 }]);
	document.getElementById('out').textContent = `Total: ${total}`;
}

document.getElementById('checkout').addEventListener('click', onCheckoutClick);
document.getElementById('out').textContent = 'pronto';
