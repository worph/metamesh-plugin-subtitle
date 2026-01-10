import Fastify from 'fastify';
import type { HealthResponse, ProcessRequest, ProcessResponse, CallbackPayload, ConfigureRequest, ConfigureResponse } from './types.js';
import { manifest, process as processFile } from './plugin.js';

const app = Fastify({ logger: true });
let ready = false;

app.get('/health', async (): Promise<HealthResponse> => ({ status: 'healthy', ready, version: manifest.version }));
app.get('/manifest', async () => manifest);
app.post<{ Body: ConfigureRequest }>('/configure', async (request): Promise<ConfigureResponse> => {
    console.log(`[${manifest.id}] Configuration updated`);
    return { status: 'ok' };
});
app.post<{ Body: ProcessRequest }>('/process', async (request, reply) => {
    const { taskId, cid, filePath, callbackUrl, metaCoreUrl } = request.body;
    if (!taskId || !cid || !filePath || !callbackUrl || !metaCoreUrl) {
        return reply.send({ status: 'rejected', error: 'Missing required fields' } as ProcessResponse);
    }
    processFile(request.body, async (payload: CallbackPayload) => {
        try { await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
        catch (error) { console.error(`[${manifest.id}] Callback error:`, error); }
    }).catch(console.error);
    return reply.send({ status: 'accepted' } as ProcessResponse);
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen({ port, host: '0.0.0.0' }).then(() => { ready = true; console.log(`[${manifest.id}] Listening on port ${port}`); });
process.on('SIGTERM', async () => { ready = false; await app.close(); process.exit(0); });
