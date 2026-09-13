/**
 * In-process stand-in for the two HTTP surfaces a plugin talks to:
 *   - WebDAV at /webdav/...  (JSON directory listing, HEAD, Range GET, PUT)
 *   - meta API at /meta/...  (GET record / property, PATCH merge, DELETE property)
 * Records are stored FLAT (`subtitles/fre/<cid>`), the way meta-core keeps them.
 */

import http from 'http';
import type { AddressInfo } from 'net';

export interface FakeCall {
    method: string;
    path: string;
    body?: unknown;
}

export interface FakeCore {
    url: string;
    webdavUrl: string;
    /** Keyed by path under /files, e.g. `/watch/show/a.mkv`. */
    files: Map<string, Buffer>;
    records: Map<string, Record<string, string>>;
    calls: FakeCall[];
    /** GET requests per file path (each ffmpeg pass opens the file at least once). */
    fileGets: Map<string, number>;
    failPatch: boolean;
    close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export async function startFakeCore(): Promise<FakeCore> {
    const core = {
        files: new Map<string, Buffer>(),
        records: new Map<string, Record<string, string>>(),
        calls: [] as FakeCall[],
        fileGets: new Map<string, number>(),
        failPatch: false,
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const pathname = decodeURIComponent(url.pathname);
        const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
            if (body === undefined) {
                res.writeHead(status, headers);
                res.end();
            } else if (Buffer.isBuffer(body)) {
                res.writeHead(status, headers);
                res.end(body);
            } else {
                res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                res.end(JSON.stringify(body));
            }
        };

        if (pathname.startsWith('/webdav')) {
            const p = pathname.slice('/webdav'.length) || '/';
            if (req.method === 'PUT') {
                core.files.set(p, await readBody(req));
                return send(201);
            }
            if (p.endsWith('/')) {
                const dir = p.replace(/\/$/, '');
                const entries = new Map<string, { name: string; type: string; size: number }>();
                for (const [fp, data] of core.files) {
                    if (!fp.startsWith(`${dir}/`)) continue;
                    const rest = fp.slice(dir.length + 1);
                    const slash = rest.indexOf('/');
                    if (slash === -1) entries.set(rest, { name: rest, type: 'file', size: data.length });
                    else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), type: 'directory', size: 512 });
                }
                return send(200, [...entries.values()]);
            }
            const data = core.files.get(p);
            if (!data) return send(404);
            if (req.method === 'HEAD') {
                return send(200, undefined, { 'Content-Length': String(data.length), 'Accept-Ranges': 'bytes' });
            }
            core.fileGets.set(p, (core.fileGets.get(p) ?? 0) + 1);
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
            if (range) {
                const start = Number(range[1]);
                const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
                if (start >= data.length) return send(416, undefined, { 'Content-Range': `bytes */${data.length}` });
                return send(206, data.subarray(start, end + 1), {
                    'Content-Range': `bytes ${start}-${end}/${data.length}`,
                    'Content-Length': String(end - start + 1),
                    'Accept-Ranges': 'bytes',
                });
            }
            return send(200, data, { 'Content-Length': String(data.length), 'Accept-Ranges': 'bytes' });
        }

        const m = /^\/meta\/([^/]+)(?:\/(.+))?$/.exec(pathname);
        if (m) {
            const [, hash, key] = m;
            const raw = await readBody(req);
            const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
            if (req.method !== 'GET') core.calls.push({ method: req.method ?? '', path: pathname, body });
            const record = core.records.get(hash);

            if (req.method === 'GET' && !key) return record ? send(200, { metadata: record }) : send(404, { error: 'not found' });
            if (req.method === 'GET' && key) {
                return record && key in record ? send(200, { value: record[key] }) : send(404, { error: 'Property not found' });
            }
            if (req.method === 'PATCH' && !key) {
                if (core.failPatch) return send(500, { error: 'boom' });
                core.records.set(hash, { ...(record ?? {}), ...(body as Record<string, string>) });
                return send(200, { status: 'ok' });
            }
            if (req.method === 'DELETE' && key) {
                if (record) delete record[key];
                return send(200, { status: 'ok' });
            }
        }
        send(404, { error: 'no route' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    return {
        ...core,
        get failPatch() { return core.failPatch; },
        set failPatch(v: boolean) { core.failPatch = v; },
        url,
        webdavUrl: `${url}/webdav`,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

/** Mutating calls (PATCH / DELETE) against one record. */
export function writesTo(core: FakeCore, hash: string): FakeCall[] {
    return core.calls.filter((c) => c.path === `/meta/${hash}` || c.path.startsWith(`/meta/${hash}/`));
}
