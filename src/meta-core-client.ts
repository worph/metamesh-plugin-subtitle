/**
 * meta-core API client for writing metadata.
 *
 * Writes report success so a failed write fails the task instead of being
 * swallowed. Key-sets are written as individual `prefix/member = "true"`
 * fields through PATCH — never via `_add`, which stores one comma-joined
 * string and can never produce the key-set shape.
 */

export class MetaCoreClient {
    constructor(private baseUrl: string) {}

    private async safeFetch(url: string, options: RequestInit): Promise<Response | null> {
        try {
            return await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
        } catch (error) {
            console.warn(`[MetaCoreClient] Warning: meta-core unavailable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    async getProperty(hashId: string, key: string): Promise<string | null> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/${key}`, { method: 'GET' });
        if (!response || !response.ok) return null;
        const data = await response.json() as { value?: unknown };
        return data.value === undefined || data.value === null ? null : String(data.value);
    }

    /**
     * Whole record, in whatever form the endpoint serves (meta-sort's /meta is
     * nested, meta-core's is flat) — callers flatten. `null` when the call
     * itself failed, `{}` when the record does not exist.
     */
    async getMetadata(hashId: string): Promise<Record<string, unknown> | null> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}`, { method: 'GET' });
        if (!response) return null;
        if (response.status === 404) return {};
        if (!response.ok) return null;
        const data = await response.json() as { metadata?: Record<string, unknown> };
        return data.metadata ?? {};
    }

    /** PATCH — merge `metadata` into the record. True on success. */
    async mergeMetadata(hashId: string, metadata: Record<string, string>): Promise<boolean> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(metadata),
        });
        if (!response) return false;
        if (!response.ok) {
            console.warn(`[MetaCoreClient] Failed to merge metadata into ${hashId}: ${response.status}`);
            return false;
        }
        return true;
    }

    /** DELETE one field. A missing field counts as deleted. */
    async deleteProperty(hashId: string, key: string): Promise<boolean> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/${key}`, { method: 'DELETE' });
        if (!response) return false;
        if (!response.ok && response.status !== 404) {
            console.warn(`[MetaCoreClient] Failed to delete ${hashId}/${key}: ${response.status}`);
            return false;
        }
        return true;
    }
}
