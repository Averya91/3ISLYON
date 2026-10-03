import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import app from '../server/index.js';

app.setWorkerEnv(env);
app.listen(3000);
const api = httpServerHandler({ port: 3000 });

export default {
  async fetch(request, bindings, ctx) {
    // Static assets are served directly by Cloudflare according to
    // assets.run_worker_first. Only /api/* and /health reach this handler.
    const response = await api.fetch(request, bindings, ctx);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
