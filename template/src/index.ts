// Sentinel deste fork, instalado pelo botão Deploy to Cloudflare. O código vem do pacote
// publicado no release "template" do repositório (package.json); aqui só se liga o Worker.
import { handleQueue, workersSentinel } from 'workers-sentinel';

export { AuthState, ProjectState, SentinelRpc } from 'workers-sentinel';

const app = workersSentinel();

export default {
	fetch: app.fetch,
	// Fila PROCESS_QUEUE: montagem dos arquivos de depuração enviados pelo sentry-cli.
	queue: handleQueue,
};
