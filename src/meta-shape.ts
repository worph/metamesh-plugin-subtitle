/**
 * Reading a record regardless of the shape it arrives in, and writing only what
 * is new.
 *
 * meta-sort's scheduler fills `existingMeta` from meta-sort's own GET /meta/{hash},
 * which returns the NESTED document (`fileinfo: {duration: 1433.089}`,
 * `stream: [...]`, a key-set as `subtitles: {fre: {<cid>: true}}`). meta-core's
 * backend serves the FLAT form (`fileinfo/duration`, `stream/0`,
 * `subtitles/fre/<cid>`). A plugin that reads `existingMeta['x/y']` silently sees
 * nothing in production — so everything here goes through `flattenMeta`.
 *
 * Byte-identical in metamesh-plugin-subtitle and metamesh-plugin-subtitle-extractor.
 */

/** Flatten either form into `a/b/c -> string` (meta-sort's flattenMetadata, plus array indices). */
export function flattenMeta(meta: Record<string, unknown> | undefined | null): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (value: unknown, key: string) => {
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, key ? `${key}/${i}` : String(i)));
        } else if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                walk(v, key ? `${key}/${k}` : k);
            }
        } else if (key) {
            out[key] = String(value);
        }
    };
    walk(meta ?? {}, '');
    return out;
}

/** The subset of `wanted` the record does not already hold with that exact value. */
export function onlyNewKeys(existingFlat: Record<string, string>, wanted: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(wanted)) {
        if (existingFlat[k] !== v) out[k] = v;
    }
    return out;
}

/**
 * Members of a LEGACY scalar csv-set (`subtitles = "cidA,cidB"`, written by the
 * old `_add` path), or null when the field is absent or already a key-set.
 *
 * Such a scalar must be deleted before any `field/...` key is written: meta-sort
 * rebuilds its nested document by walking the `/`-segments, and a string sitting
 * where an object is needed either throws or silently hides the key-set.
 */
export function legacyCsvMembers(meta: Record<string, unknown> | undefined | null, field: string): string[] | null {
    const v = meta?.[field];
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    return String(v).split(/[,|]/).map((s) => s.trim()).filter(Boolean);
}

/** Every `<prefix>/<lang>/<cid>` leaf for `cid` whose language is not `lang3`. */
export function staleLanguageLeaves(existingFlat: Record<string, string>, prefix: string, cid: string, lang3: string): string[] {
    const stale: string[] = [];
    for (const key of Object.keys(existingFlat)) {
        const parts = key.split('/');
        if (parts.length === 3 && parts[0] === prefix && parts[2] === cid && parts[1] !== lang3) stale.push(key);
    }
    return stale;
}
