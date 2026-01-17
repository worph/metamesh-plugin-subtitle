/**
 * WebDAV Client for Plugin File Access
 *
 * Provides HTTP-based file access to meta-sort's WebDAV endpoint.
 * Replaces direct filesystem access for containerized plugins.
 */

export interface FileStats {
    size: number;
    mtime?: Date;
}

export class WebDAVClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        // Remove trailing slash if present
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    /**
     * Convert absolute file path to WebDAV URL
     * Strips /files prefix and appends to base URL
     */
    toWebDAVUrl(filePath: string): string {
        // filePath is like "/files/watch/movie.mkv"
        // We need to convert to "http://meta-sort-dev/webdav/watch/movie.mkv"
        let relativePath = filePath;

        // Strip /files prefix if present
        if (relativePath.startsWith('/files/')) {
            relativePath = relativePath.substring(6); // Remove "/files"
        } else if (relativePath.startsWith('/files')) {
            relativePath = relativePath.substring(6);
        }

        // Ensure path starts with /
        if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
        }

        return this.baseUrl + relativePath;
    }

    /**
     * Get file stats (size, mtime) via HTTP HEAD request
     */
    async stat(filePath: string): Promise<FileStats> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'HEAD' });

        if (!response.ok) {
            throw new Error(`WebDAV HEAD failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const lastModified = response.headers.get('last-modified');

        return {
            size: contentLength ? parseInt(contentLength, 10) : 0,
            mtime: lastModified ? new Date(lastModified) : undefined,
        };
    }

    /**
     * Read first N bytes of a file (for language detection)
     * Uses HTTP Range request
     */
    async readBytes(filePath: string, start: number, end: number): Promise<Buffer> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Range': `bytes=${start}-${end}`,
            },
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`WebDAV Range GET failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Read entire file as buffer (for small files)
     */
    async readFile(filePath: string): Promise<Buffer> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'GET' });

        if (!response.ok) {
            throw new Error(`WebDAV GET failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Check if file exists via HTTP HEAD
     */
    async exists(filePath: string): Promise<boolean> {
        const url = this.toWebDAVUrl(filePath);

        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * List directory contents via HTTP GET (returns JSON from nginx autoindex)
     */
    async readdir(dirPath: string): Promise<string[]> {
        const url = this.toWebDAVUrl(dirPath);
        const finalUrl = url.endsWith('/') ? url : url + '/';

        const response = await fetch(finalUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`WebDAV GET (dir) failed for ${dirPath}: ${response.status} ${response.statusText}`);
        }

        const entries = await response.json() as Array<{ name: string; type: string }>;
        return entries.map(e => e.name);
    }
}

/**
 * Create a WebDAV client from environment variables
 */
export function createWebDAVClient(): WebDAVClient | null {
    const webdavUrl = process.env.WEBDAV_URL;

    if (!webdavUrl) {
        console.warn('[webdav-client] WEBDAV_URL not set, WebDAV client unavailable');
        return null;
    }

    return new WebDAVClient(webdavUrl);
}
