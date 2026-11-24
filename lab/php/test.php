<?php
// Teste do SDK oficial de PHP (sentry/sentry) contra o Sentinel Lab.
require __DIR__ . '/vendor/autoload.php';

\Sentry\init([
    'dsn' => getenv('SENTINEL_DSN'),
    'release' => 'php-api@1.0.0',
    'environment' => 'production',
    'traces_sample_rate' => 1.0,
]);

\Sentry\configureScope(function (\Sentry\State\Scope $scope): void {
    $scope->setUser(['id' => 'u-7', 'email' => 'cliente@example.com']);
    $scope->setTag('service', 'pedidos-php');
});

class PedidoService
{
    public function calcularFrete(?array $pedido): float
    {
        return $pedido['endereco']['cep'] * 0.01; // TypeError quando o pedido é null
    }
}

try {
    (new PedidoService())->calcularFrete(null);
} catch (\Throwable $e) {
    \Sentry\captureException($e);
}

\Sentry\captureMessage('Estoque abaixo do mínimo para SKU-123', \Sentry\Severity::warning());

echo "eventos enviados\n";
