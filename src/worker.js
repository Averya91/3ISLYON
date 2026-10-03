import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import app from '../server/index.js';

app.setWorkerEnv(env);
app.listen(3000);
const api = httpServerHandler({ port: 3000 });

export default {
  async fetch(request, bindings, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') {
      return env.ASSETS.fetch(request);
    }
    const response = await api.fetch(request, bindings, ctx);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  }
};
