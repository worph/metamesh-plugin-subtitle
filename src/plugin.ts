/**
 * Subtitle Plugin
 *
 * Links subtitle SIDECAR files to the video they sit next to, in both
 * directions, and determines each sidecar's language.
 *
 * ============================================================================
 * WHAT IT WRITES (METADATA_KEYS.md §8)
 * ============================================================================
 * On the video record, per sidecar `<subCid>` (midhash256) in `<lang3>`
 * (ISO 639-2/B, `und` when undetermined):
 *   subtitles/<lang3>/<subCid>   = "true"     what meta-watch lists
 *   subtitleLanguages/<lang3>    = "true"     (not for `und`)
 * On the sidecar's own record:
 *   videos/<videoCid>            = "true"
 *   subtitleLanguage             = <lang3>    (not for `und`)
 *
 * Whichever of the two records is processed first, the result is the same: each
 * run writes its own record in full, and the other record only when it already
 * exists (no stub records carrying nothing but subtitle keys). Writes are one
 * PATCH of only-new keys; a failed write fails the task.
 *
 * ============================================================================
 * WHAT COUNTS AS A SIDECAR
 * ============================================================================
 * `<video basename>.<ext>` or `<video basename>.<qualifiers>.<ext>`, compared
 * case-insensitively, `<ext>` in srt/ass/ssa/vtt, where every qualifier token is
 * a language (`en`, `eng`, `fre`, `pt-BR`, `English`) or a flag (`forced`, `sdh`,
 * `cc`, `hi`, `default`, `full`, `signs`, `songs`). So `Movie.fr.forced.srt`
 * belongs to `Movie.mkv`, but `Movie.Extended.eng.srt` does not.
 * Language: the qualifier token when there is one, else a franc-min sniff of the
 * subtitle text (timecodes and ASS markup stripped), else `und`. `hi` is read as
 * the hearing-impaired flag, not Hindi (use `hin`).
 *
 * ============================================================================
 * FILE ACCESS - WebDAV only
 * ============================================================================
 * The container has no /files mount. Directory listings, size and bytes all come
 * over WebDAV from the meta-core that drove the /process call (its /urls ->
 * webdavUrlInternal; WEBDAV_URL overrides).
 */

import { posix } from 'path';
import { createHash } from 'crypto';
import { franc } from 'franc-min';
import { FileType } from '@metazla/filename-tools';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { getWebDAVClient, WebDAVClient, DirectoryEntry } from './webdav-client.js';
import { languageToken, francToLang3 } from './langs.js';
import { flattenMeta, onlyNewKeys, legacyCsvMembers, staleLanguageLeaves } from './meta-shape.js';

const fileTypeTool = new FileType();

export const SIDECAR_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt']);

/** Bytes of subtitle text read for language detection (ASS style headers can run several KB). */
const DETECT_BYTES = 64 * 1024;

const FLAG_TOKENS: Record<string, 'forced' | 'hearingImpaired' | 'other'> = {
    forced: 'forced',
    sdh: 'hearingImpaired',
    cc: 'hearingImpaired',
    hi: 'hearingImpaired',
    default: 'other',
    full: 'other',
    signs: 'other',
    songs: 'other',
};

export const manifest: PluginManifest = {
    id: 'subtitle',
    name: 'Subtitle Processor',
    version: '1.1.0',
    description: 'Links subtitle sidecar files to their videos and detects their language',
    author: 'MetaMesh',
    dependencies: ['file-info'],
    priority: 45,
    color: '#00BCD4',
    defaultQueue: 'fast',
    timeout: 30000,
    schema: {
        subtitleLanguage: { label: 'Subtitle Language', type: 'string', readonly: true },
        videos: { label: 'Linked Videos', type: 'json', readonly: true, hint: 'videos/<cid>' },
        subtitles: { label: 'Linked Subtitles', type: 'json', readonly: true, hint: 'subtitles/<lang3>/<cid>' },
    },
    config: {},
};

// ----------------------------------------------------------------------------
// Names
// ----------------------------------------------------------------------------

export function splitExtension(fileName: string): { base: string; ext: string } {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return { base: fileName, ext: '' };
    return { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1).toLowerCase() };
}

export interface SubtitleQualifiers {
    lang3?: string;
    forced: boolean;
    hearingImpaired: boolean;
}

/** Qualifier tokens (`fr`, `forced`, …); null as soon as one is neither a language nor a flag. */
export function parseQualifierTokens(tokens: string[]): SubtitleQualifiers | null {
    const q: SubtitleQualifiers = { forced: false, hearingImpaired: false };
    for (const raw of tokens) {
        const token = raw.trim().toLowerCase();
        if (!token) continue;
        const flag = FLAG_TOKENS[token];
        if (flag === 'forced') q.forced = true;
        else if (flag === 'hearingImpaired') q.hearingImpaired = true;
        else if (flag !== 'other') {
            const lang = languageToken(token);
            if (!lang) return null;
            q.lang3 ??= lang;
        }
    }
    return q;
}

/** Is `candidate` a sidecar of `videoFileName`, and what do its qualifiers say? */
export function parseSidecarName(videoFileName: string, candidate: string): (SubtitleQualifiers & { ext: string }) | null {
    const { ext } = splitExtension(candidate);
    if (!SIDECAR_EXTENSIONS.has(ext)) return null;
    const videoBase = splitExtension(videoFileName).base.toLowerCase();
    const base = splitExtension(candidate).base;
    if (!videoBase) return null;
    if (base.toLowerCase() === videoBase) return { ext, forced: false, hearingImpaired: false };
    if (!base.toLowerCase().startsWith(`${videoBase}.`)) return null;
    const q = parseQualifierTokens(base.slice(videoBase.length + 1).split('.'));
    return q ? { ...q, ext } : null;
}

/** Qualifiers read off the end of a subtitle's own name, when no sibling video anchors it. */
export function trailingQualifiers(fileName: string): SubtitleQualifiers {
    const tokens = splitExtension(fileName).base.split('.');
    const q: SubtitleQualifiers = { forced: false, hearingImpaired: false };
    // Keep at least one token as the name proper.
    for (let i = tokens.length - 1; i >= 1; i--) {
        const one = parseQualifierTokens([tokens[i]]);
        if (!one) break;
        q.forced ||= one.forced;
        q.hearingImpaired ||= one.hearingImpaired;
        // Walking backwards: the token nearest the name wins, as in parseQualifierTokens.
        if (one.lang3) q.lang3 = one.lang3;
    }
    return q;
}

// ----------------------------------------------------------------------------
// Language sniffing
// ----------------------------------------------------------------------------

/** The spoken text of a subtitle file: no counters, timecodes, headers or markup. */
export function cleanSubtitleText(raw: string, ext: string): string {
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    let text: string[];
    if (ext === 'ass' || ext === 'ssa') {
        text = lines
            .filter((l) => l.startsWith('Dialogue:'))
            .map((l) => l.split(',').slice(9).join(','))
            .map((l) => l.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' '));
    } else {
        text = lines.filter((l) => {
            const t = l.trim();
            return t && !/^\d+$/.test(t) && !t.includes('-->') && !/^WEBVTT/.test(t) && !/^(NOTE|STYLE|REGION)\b/.test(t);
        });
    }
    return text
        .join(' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** lang3 from subtitle text, `und` when there is too little to tell. */
export function detectLanguageFromText(text: string): string {
    if (text.length < 20) return 'und';
    const code = franc(text);
    return code === 'und' ? 'und' : francToLang3(code);
}

// ----------------------------------------------------------------------------
// CIDs
// ----------------------------------------------------------------------------

const MIDHASH_SAMPLE_SIZE = 1024 * 1024;

/** midhash256 CID from a file's size and its middle sample (matches meta-hash). */
export function computeMidHash256(fileSize: number, sampleData: Buffer): string {
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);
    const hashBuffer = createHash('sha256').update(Buffer.concat([sizeBuffer, sampleData])).digest();
    const cidBytes = Buffer.concat([Buffer.from([0x01]), MIDHASH_VARINT, MIDHASH_VARINT, Buffer.from([0x20]), hashBuffer]);

    const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let cid = 'b';
    let bits = 0;
    let value = 0;
    for (const byte of cidBytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            cid += base32Chars[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        cid += base32Chars[(value << (5 - bits)) & 0x1f];
    }
    return cid;
}

export function midhashSampleRange(fileSize: number): { start: number; end: number } {
    if (fileSize <= MIDHASH_SAMPLE_SIZE) return { start: 0, end: fileSize - 1 };
    const start = Math.floor((fileSize - MIDHASH_SAMPLE_SIZE) / 2);
    return { start, end: start + MIDHASH_SAMPLE_SIZE - 1 };
}

export function computeMidHash256FromBuffer(data: Buffer): string {
    const { start, end } = midhashSampleRange(data.length);
    return computeMidHash256(data.length, data.subarray(start, end + 1));
}

/** CID of a file over WebDAV: one Range read of at most 1 MiB, however large the file. */
export async function midhashOverWebDAV(client: WebDAVClient, filePath: string, size?: number): Promise<string> {
    const fileSize = size ?? (await client.stat(filePath)).size;
    const { start, end } = midhashSampleRange(fileSize);
    const sample = fileSize === 0 ? Buffer.alloc(0) : await client.readBytes(filePath, start, end);
    if (sample.length !== end - start + 1) {
        throw new Error(`short read for ${filePath}: wanted ${end - start + 1} bytes, got ${sample.length}`);
    }
    return computeMidHash256(fileSize, sample);
}

// ----------------------------------------------------------------------------
// Record keys
// ----------------------------------------------------------------------------

/**
 * Keys on the video record for one linked subtitle (METADATA_KEYS.md §8, §9).
 *
 * The language lands in `subtitleLanguages/<lang3>` **and** in the
 * `languages/<lang3>` union — §9 rule #7: "a union field is written, never
 * computed". Nothing reconciles them afterwards, and `languages` is the only
 * field a query filters on, so a subtitle language recorded in the split alone
 * is invisible to every language filter on every peer. This mirrors
 * subtitle-extractor's `videoSubtitleKeys`, which has always written both.
 */
export function videoSubtitleKeys(subCid: string, lang3: string): Record<string, string> {
    const keys: Record<string, string> = { [`subtitles/${lang3}/${subCid}`]: 'true' };
    if (lang3 !== 'und') {
        keys[`subtitleLanguages/${lang3}`] = 'true';
        keys[`languages/${lang3}`] = 'true';
    }
    return keys;
}

export function subtitleRecordKeys(lang3: string, videoCids: string[]): Record<string, string> {
    const keys: Record<string, string> = {};
    for (const v of videoCids) keys[`videos/${v}`] = 'true';
    if (lang3 !== 'und') keys.subtitleLanguage = lang3;
    return keys;
}

async function detectFromFile(client: WebDAVClient, filePath: string, ext: string, size?: number): Promise<string> {
    if (size === 0) return 'und';
    const end = size !== undefined ? Math.min(size, DETECT_BYTES) - 1 : DETECT_BYTES - 1;
    const bytes = await client.readBytes(filePath, 0, end);
    return detectLanguageFromText(cleanSubtitleText(bytes.toString('utf8'), ext));
}

/**
 * Link `subCid`/`lang3` onto a video record that is not the one being processed:
 * only if it exists, only new keys, and with any other-language leaf for the
 * same CID removed (one file, one language).
 */
async function linkOntoVideo(metaCore: MetaCoreClient, videoCid: string, subCid: string, lang3: string): Promise<boolean> {
    const current = await metaCore.getMetadata(videoCid);
    if (current === null) return false;
    const flat = flattenMeta(current);
    if (!flat.fileType) return true; // not indexed yet — its own run links it
    return writeVideoLinks(metaCore, videoCid, current, flat, [{ subCid, lang3 }]);
}

async function writeVideoLinks(
    metaCore: MetaCoreClient,
    videoCid: string,
    meta: Record<string, unknown>,
    flat: Record<string, string>,
    links: Array<{ subCid: string; lang3: string }>,
): Promise<boolean> {
    const deletes: string[] = [];
    const sets: Record<string, string> = {};

    // Legacy scalar csv-sets from the `_add` era. Members still found on disk are
    // re-linked with their language below; the rest are kept as `und` leaves.
    const legacySubs = legacyCsvMembers(meta, 'subtitles');
    if (legacySubs) {
        deletes.push('subtitles');
        for (const cid of legacySubs) {
            if (!links.some((l) => l.subCid === cid)) sets[`subtitles/und/${cid}`] = 'true';
        }
    }
    const legacyLangs = legacyCsvMembers(meta, 'subtitleLanguages');
    if (legacyLangs) {
        deletes.push('subtitleLanguages');
        for (const code of legacyLangs) {
            const l = languageToken(code);
            if (l && l !== 'und') {
                sets[`subtitleLanguages/${l}`] = 'true';
                // The legacy csv never had a union member to migrate, so the
                // migration is also the only chance to satisfy §9 rule #7 for
                // these records.
                sets[`languages/${l}`] = 'true';
            }
        }
    }
    for (const { subCid, lang3 } of links) deletes.push(...staleLanguageLeaves(flat, 'subtitles', subCid, lang3));

    for (const key of deletes) {
        if (!(await metaCore.deleteProperty(videoCid, key))) return false;
        delete flat[key];
    }

    let wanted: Record<string, string> = { ...sets };
    for (const { subCid, lang3 } of links) wanted = { ...wanted, ...videoSubtitleKeys(subCid, lang3) };
    const fresh = onlyNewKeys(flat, wanted);
    return Object.keys(fresh).length === 0 || metaCore.mergeMetadata(videoCid, fresh);
}

async function writeSubtitleRecord(
    metaCore: MetaCoreClient,
    subCid: string,
    meta: Record<string, unknown>,
    lang3: string,
    videoCids: string[],
): Promise<boolean> {
    const flat = flattenMeta(meta);
    const sets: Record<string, string> = {};
    const legacyVideos = legacyCsvMembers(meta, 'videos');
    if (legacyVideos) {
        if (!(await metaCore.deleteProperty(subCid, 'videos'))) return false;
        delete flat.videos;
        for (const v of legacyVideos) sets[`videos/${v}`] = 'true';
    }
    const fresh = onlyNewKeys(flat, { ...sets, ...subtitleRecordKeys(lang3, videoCids) });
    return Object.keys(fresh).length === 0 || metaCore.mergeMetadata(subCid, fresh);
}

// ----------------------------------------------------------------------------
// Task
// ----------------------------------------------------------------------------

type Outcome = { ok: true; summary: string } | { ok: false; error: string };

/** Video record: find its sidecars, link them. */
export async function processVideoFile(
    client: WebDAVClient,
    metaCore: MetaCoreClient,
    videoCid: string,
    filePath: string,
    meta: Record<string, unknown>,
): Promise<Outcome> {
    const dir = posix.dirname(filePath);
    const videoName = posix.basename(filePath);
    const entries = await client.list(dir);

    const links: Array<{ subCid: string; lang3: string; entry: DirectoryEntry }> = [];
    for (const entry of entries) {
        if (entry.type !== 'file' || entry.size === 0) continue;
        const q = parseSidecarName(videoName, entry.name);
        if (!q) continue;
        const subPath = `${dir}/${entry.name}`;
        const subCid = await midhashOverWebDAV(client, subPath, entry.size);
        const lang3 = q.lang3 ?? (await detectFromFile(client, subPath, q.ext, entry.size));
        links.push({ subCid, lang3, entry });
    }

    const flat = flattenMeta(meta);
    if (!(await writeVideoLinks(metaCore, videoCid, meta, flat, links))) {
        return { ok: false, error: 'meta-core write failed (video record)' };
    }

    for (const { subCid, lang3 } of links) {
        const subMeta = await metaCore.getMetadata(subCid);
        if (subMeta === null) return { ok: false, error: `meta-core read failed (${subCid})` };
        if (!flattenMeta(subMeta).fileType) continue; // not indexed yet — its own run links it
        if (!(await writeSubtitleRecord(metaCore, subCid, subMeta, lang3, [videoCid]))) {
            return { ok: false, error: `meta-core write failed (${subCid})` };
        }
    }
    return { ok: true, summary: `${links.length} sidecar(s) [${links.map((l) => l.lang3).join(', ')}]` };
}

/** Subtitle record: find the video(s) it belongs to, determine its language, link. */
export async function processSubtitleFile(
    client: WebDAVClient,
    metaCore: MetaCoreClient,
    subCid: string,
    filePath: string,
    meta: Record<string, unknown>,
): Promise<Outcome> {
    const dir = posix.dirname(filePath);
    const subName = posix.basename(filePath);
    const ext = splitExtension(subName).ext;

    // Plugin output folders (subtitle-extractor, opensubtitles, meta-watch uploads)
    // hold no videos; their names already end in `.<lang3>.<ext>`.
    const videos: DirectoryEntry[] = [];
    if (!dir.startsWith('/files/plugin/') && SIDECAR_EXTENSIONS.has(ext)) {
        for (const entry of await client.list(dir)) {
            if (entry.type !== 'file') continue;
            if (fileTypeTool.getFileTypeFromExtension(entry.name) !== 'video') continue;
            if (parseSidecarName(entry.name, subName)) videos.push(entry);
        }
    }

    // Same qualifiers the video-side run derives, so both runs agree on the language.
    const q = videos.length > 0 ? parseSidecarName(videos[0].name, subName)! : trailingQualifiers(subName);
    const size = meta.sizeByte !== undefined && Number.isFinite(Number(meta.sizeByte)) ? Number(meta.sizeByte) : undefined;
    const lang3 = q.lang3 ?? (await detectFromFile(client, filePath, ext, size));

    const videoCids: string[] = [];
    for (const v of videos) videoCids.push(await midhashOverWebDAV(client, `${dir}/${v.name}`, v.size));

    if (!(await writeSubtitleRecord(metaCore, subCid, meta, lang3, videoCids))) {
        return { ok: false, error: 'meta-core write failed (subtitle record)' };
    }
    for (const videoCid of videoCids) {
        if (!(await linkOntoVideo(metaCore, videoCid, subCid, lang3))) {
            return { ok: false, error: `meta-core write failed (${videoCid})` };
        }
    }
    return { ok: true, summary: `lang=${lang3}, ${videoCids.length} video(s)` };
}

/**
 * A subtitle file the byte classifier could not place. file-info returns
 * `undefined` for a `text/plain` sniff (METADATA_KEYS.md `fileType`: "could be a
 * document, a subtitle or anything") and has been seen writing `other` for
 * extracted `.ass` files — either way the `fileType === 'subtitle'` gate alone
 * would never let this plugin see the file. The extension decides then.
 */
export function isUnclassifiedSubtitle(meta: Record<string, unknown>, filePath: string): boolean {
    const fileType = meta.fileType;
    if (fileType !== undefined && fileType !== null && fileType !== '' && fileType !== 'other' && fileType !== 'undefined') {
        return false;
    }
    const ext = typeof meta.extension === 'string' && meta.extension
        ? meta.extension.toLowerCase()
        : splitExtension(posix.basename(filePath)).ext;
    return SIDECAR_EXTENSIONS.has(ext);
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const { taskId, cid, filePath } = request;
    const meta = (request.existingMeta ?? {}) as Record<string, unknown>;
    const finish = (status: CallbackPayload['status'], extra: { reason?: string; error?: string } = {}) =>
        sendCallback({ taskId, status, duration: Date.now() - startTime, ...extra });

    try {
        const fileType = meta.fileType === 'subtitle' || isUnclassifiedSubtitle(meta, filePath) ? 'subtitle' : meta.fileType;
        if (fileType !== 'video' && fileType !== 'subtitle') {
            await finish('skipped', { reason: 'Not a video or subtitle file' });
            return;
        }

        const client = await getWebDAVClient(request.metaCoreUrl);
        if (!client) {
            console.error(`[subtitle] ${filePath}: no WebDAV endpoint available`);
            await finish('failed', { error: 'No WebDAV endpoint available' });
            return;
        }

        const metaCore = new MetaCoreClient(request.metaCoreUrl);
        const outcome = fileType === 'subtitle'
            ? await processSubtitleFile(client, metaCore, cid, filePath, meta)
            : await processVideoFile(client, metaCore, cid, filePath, meta);

        if (!outcome.ok) {
            console.error(`[subtitle] ${filePath}: ${outcome.error}`);
            await finish('failed', { error: outcome.error });
            return;
        }
        console.log(`[subtitle] ${filePath}: ${outcome.summary}`);
        await finish('completed');
    } catch (error) {
        console.error(`[subtitle] ${filePath}:`, error);
        await finish('failed', { error: error instanceof Error ? error.message : String(error) });
    }
}
