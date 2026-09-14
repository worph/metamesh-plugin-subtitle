/**
 * Subtitle Plugin Tests — pure helpers plus both processing directions against
 * an in-process fake WebDAV + meta API (no Docker, no ffmpeg).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
    manifest,
    process as processFile,
    splitExtension,
    parseSidecarName,
    trailingQualifiers,
    cleanSubtitleText,
    detectLanguageFromText,
    computeMidHash256,
    computeMidHash256FromBuffer,
    midhashSampleRange,
    videoSubtitleKeys,
    subtitleRecordKeys,
    isUnclassifiedSubtitle,
} from '../src/plugin.js';
import { toLang3, languageToken, francToLang3 } from '../src/langs.js';
import { flattenMeta, onlyNewKeys, legacyCsvMembers, staleLanguageLeaves } from '../src/meta-shape.js';
import type { CallbackPayload } from '../src/types.js';
import { startFakeCore, writesTo, type FakeCore } from './fake-core.js';

const ENGLISH_SRT = `1
00:00:01,000 --> 00:00:04,000
<i>Where were you last night?</i>

2
00:00:04,500 --> 00:00:08,000
I was at home, reading the letters my father left me.

3
00:00:08,500 --> 00:00:12,000
You should have called. We were all worried about you.

4
00:00:12,500 --> 00:00:16,000
I know, and I am sorry. It will not happen again.
`;

const FRENCH_SRT = `1
00:00:01,000 --> 00:00:04,000
Où étais-tu hier soir ?

2
00:00:04,500 --> 00:00:08,000
J'étais à la maison, en train de lire les lettres que mon père m'a laissées.

3
00:00:08,500 --> 00:00:12,000
Tu aurais dû appeler. Nous étions tous inquiets pour toi.

4
00:00:12,500 --> 00:00:16,000
Je sais, et je suis désolé. Cela ne se reproduira plus.
`;

const ENGLISH_ASS = `[Script Info]
Title: test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Arial,20,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Where were you last night?{\\i0}
Dialogue: 0,0:00:04.50,0:00:08.00,Default,,0,0,0,,I was at home,\\Nreading the letters my father left me.
Dialogue: 0,0:00:08.50,0:00:12.00,Default,,0,0,0,,You should have called. We were all worried about you.
`;

/** Deterministic pseudo-video bigger than the 1 MiB midhash sample. */
function fakeVideo(bytes: number, seed: number): Buffer {
    const b = Buffer.alloc(bytes);
    let x = seed;
    for (let i = 0; i < bytes; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        b[i] = x & 0xff;
    }
    return b;
}

describe('manifest', () => {
    it('runs after file-info on the fast queue', () => {
        expect(manifest.id).toBe('subtitle');
        expect(manifest.dependencies).toEqual(['file-info']);
        expect(manifest.defaultQueue).toBe('fast');
    });
});

describe('language normalisation (ISO 639-2/B, same as meta-watch)', () => {
    it('folds 639-1, 639-2/T, BCP-47 and names onto 639-2/B', () => {
        expect(toLang3('fr')).toBe('fre');
        expect(toLang3('fra')).toBe('fre');
        expect(toLang3('ger')).toBe('ger');
        expect(toLang3('deu')).toBe('ger');
        expect(toLang3('zh')).toBe('chi');
        expect(toLang3('pt-BR')).toBe('por');
        expect(toLang3('French')).toBe('fre');
    });

    it('uses und for no language and junk', () => {
        for (const v of ['', 'und', 'zxx', 'qq', undefined]) expect(toLang3(v)).toBe('und');
    });

    it('folds franc-min results, including its non-639-2 codes', () => {
        expect(francToLang3('fra')).toBe('fre');
        expect(francToLang3('deu')).toBe('ger');
        expect(francToLang3('cmn')).toBe('chi');
        expect(francToLang3('eng')).toBe('eng');
    });

    it('filename tokens resolve only when they are plainly a language', () => {
        expect(languageToken('en')).toBe('eng');
        expect(languageToken('ENG')).toBe('eng');
        expect(languageToken('pt-BR')).toBe('por');
        expect(languageToken('English')).toBe('eng');
        expect(languageToken('und')).toBe('und');
        for (const t of ['S01E01', 'x264', '1080p', 'Extended', 'WEB', 'tlh']) expect(languageToken(t)).toBeNull();
    });
});

describe('parseSidecarName', () => {
    const video = 'Show - S01E01 (1080p).mkv';
    const cases: Array<[string, { lang3?: string; forced?: boolean; hearingImpaired?: boolean; ext?: string } | null]> = [
        ['Show - S01E01 (1080p).srt', { lang3: undefined, ext: 'srt' }],
        ['Show - S01E01 (1080p).eng.srt', { lang3: 'eng' }],
        ['Show - S01E01 (1080p).en.srt', { lang3: 'eng' }],
        ['Show - S01E01 (1080p).fr.forced.srt', { lang3: 'fre', forced: true }],
        ['Show - S01E01 (1080p).fra.srt', { lang3: 'fre' }],
        ['Show - S01E01 (1080p).pt-BR.ass', { lang3: 'por', ext: 'ass' }],
        ['Show - S01E01 (1080p).English.sdh.vtt', { lang3: 'eng', hearingImpaired: true, ext: 'vtt' }],
        ['show - s01e01 (1080P).DE.ssa', { lang3: 'ger', ext: 'ssa' }],
        ['Show - S01E01 (1080p).hi.srt', { lang3: undefined, hearingImpaired: true }],
        ['Show - S01E01 (1080p).forced.srt', { lang3: undefined, forced: true }],
        ['Show - S01E01 (1080p).Extended.eng.srt', null],
        ['Show - S01E01 (1080p).sub', null],
        ['Show - S01E01 (1080p).idx', null],
        ['Show - S01E02 (1080p).eng.srt', null],
        ['Show - S01E01 (1080p) extra.srt', null],
    ];

    it.each(cases)('%s', (candidate, expected) => {
        const got = parseSidecarName(video, candidate);
        if (expected === null) {
            expect(got).toBeNull();
        } else {
            expect(got).not.toBeNull();
            expect(got!.lang3).toBe(expected.lang3);
            expect(got!.forced).toBe(expected.forced ?? false);
            expect(got!.hearingImpaired).toBe(expected.hearingImpaired ?? false);
            expect(got!.ext).toBe(expected.ext ?? 'srt');
        }
    });

    it('splitExtension lowercases the extension only', () => {
        expect(splitExtension('A.B.SRT')).toEqual({ base: 'A.B', ext: 'srt' });
        expect(splitExtension('.hidden')).toEqual({ base: '.hidden', ext: '' });
    });
});

describe('trailingQualifiers (subtitle files without a sibling video)', () => {
    it('reads the subtitle-extractor naming', () => {
        expect(trailingQualifiers('Show (2024)[bagvid]_subtitle.s4.eng.forced.ass')).toEqual({ lang3: 'eng', forced: true, hearingImpaired: false });
    });

    it('reads meta-watch upload and opensubtitles naming', () => {
        expect(trailingQualifiers('0123456789abcdef.fre.srt').lang3).toBe('fre');
        expect(trailingQualifiers('Show[bagvid]_subtitle.ger.srt').lang3).toBe('ger');
    });

    it('never takes the whole name as a qualifier', () => {
        expect(trailingQualifiers('english.srt').lang3).toBeUndefined();
        expect(trailingQualifiers('Movie.2019.srt').lang3).toBeUndefined();
    });
});

describe('language sniffing', () => {
    it('strips counters, timecodes and tags from SRT', () => {
        const text = cleanSubtitleText(ENGLISH_SRT, 'srt');
        expect(text).not.toMatch(/-->|<i>|^1 /);
        expect(text.startsWith('Where were you last night?')).toBe(true);
    });

    it('keeps only dialogue text from ASS', () => {
        const text = cleanSubtitleText(ENGLISH_ASS, 'ass');
        expect(text).not.toMatch(/Script Info|Style:|\{\\i1\}|\\N/);
        expect(text).toContain('I was at home, reading the letters');
    });

    it('detects English and French as lang3', () => {
        expect(detectLanguageFromText(cleanSubtitleText(ENGLISH_SRT, 'srt'))).toBe('eng');
        expect(detectLanguageFromText(cleanSubtitleText(FRENCH_SRT, 'srt'))).toBe('fre');
        expect(detectLanguageFromText(cleanSubtitleText(ENGLISH_ASS, 'ass'))).toBe('eng');
    });

    it('answers und when there is too little text', () => {
        expect(detectLanguageFromText('ok')).toBe('und');
        expect(detectLanguageFromText(cleanSubtitleText('1\n00:00:00,000 --> 00:00:01,000\n♪\n', 'srt'))).toBe('und');
    });
});

describe('midhash256', () => {
    it('matches meta-hash for a known buffer', () => {
        expect(computeMidHash256FromBuffer(Buffer.from('metamesh-still-extractor-cid-vector')))
            .toBe('bagacbabaecybg7wcyxl7su3dvjleuwgwil5tgeoybrwc35jasqtywb6bnjzk4');
    });

    it('needs only the middle 1 MiB of a large file', () => {
        const big = fakeVideo(3 * 1024 * 1024 + 7, 1);
        const { start, end } = midhashSampleRange(big.length);
        expect(end - start + 1).toBe(1024 * 1024);
        expect(computeMidHash256(big.length, big.subarray(start, end + 1))).toBe(computeMidHash256FromBuffer(big));
    });
});

describe('record keys (METADATA_KEYS.md §8)', () => {
    it('video: language-nested leaf, plus the facet AND the union for a known language', () => {
        // §9 rule #7 — the split never travels without the union, because
        // `languages` is the only field a query filters on.
        expect(videoSubtitleKeys('bagsub', 'fre')).toEqual({
            'subtitles/fre/bagsub': 'true',
            'subtitleLanguages/fre': 'true',
            'languages/fre': 'true',
        });
        // `und` is never a member of either set (§9).
        expect(videoSubtitleKeys('bagsub', 'und')).toEqual({ 'subtitles/und/bagsub': 'true' });
    });

    it('subtitle: back-pointer key-set and the language when determined', () => {
        expect(subtitleRecordKeys('eng', ['bagv1', 'bagv2'])).toEqual({ 'videos/bagv1': 'true', 'videos/bagv2': 'true', subtitleLanguage: 'eng' });
        expect(subtitleRecordKeys('und', ['bagv1'])).toEqual({ 'videos/bagv1': 'true' });
    });
});

describe('meta-shape helpers', () => {
    it('the nested and flat payloads flatten to the same keys', () => {
        const nested = { fileType: 'video', subtitles: { fre: { bagsub: true } }, fileinfo: { duration: 12.5 } };
        const flat = { fileType: 'video', 'subtitles/fre/bagsub': 'true', 'fileinfo/duration': '12.5' };
        expect(flattenMeta(nested)).toEqual(flat);
        expect(flattenMeta(flat)).toEqual(flat);
    });

    it('legacyCsvMembers only fires on a scalar', () => {
        expect(legacyCsvMembers({ subtitles: 'a,b' }, 'subtitles')).toEqual(['a', 'b']);
        expect(legacyCsvMembers({ subtitles: { fre: { a: true } } }, 'subtitles')).toBeNull();
        expect(legacyCsvMembers({}, 'subtitles')).toBeNull();
    });

    it('onlyNewKeys / staleLanguageLeaves', () => {
        expect(onlyNewKeys({ 'subtitles/fre/a': 'true' }, { 'subtitles/fre/a': 'true', 'subtitles/eng/b': 'true' }))
            .toEqual({ 'subtitles/eng/b': 'true' });
        expect(staleLanguageLeaves({ 'subtitles/und/a': 'true', 'subtitles/fre/a': 'true', 'subtitles/und/b': 'true' }, 'subtitles', 'a', 'fre'))
            .toEqual(['subtitles/und/a']);
    });
});

describe('process against a fake core', () => {
    let core: FakeCore;
    const dir = '/watch/Show';
    const videoName = 'Show - S01E01.mkv';
    const video = fakeVideo(3 * 1024 * 1024, 7);
    const videoCid = computeMidHash256FromBuffer(video);
    const sidecars: Record<string, Buffer> = {
        'Show - S01E01.srt': Buffer.from(ENGLISH_SRT),
        'Show - S01E01.fr.forced.srt': Buffer.from(FRENCH_SRT),
        'Show - S01E01.eng.ass': Buffer.from(ENGLISH_ASS),
        'Show - S01E01.Extended.eng.srt': Buffer.from(ENGLISH_SRT + '\n'),
        'Show - S01E02.srt': Buffer.from(ENGLISH_SRT + '\n\n'),
    };
    const cid = (name: string) => computeMidHash256FromBuffer(sidecars[name]);

    const run = async (fileCid: string, filePath: string, existingMeta: Record<string, unknown>, metaCoreUrl = core.url) => {
        const seen: CallbackPayload[] = [];
        await processFile({ taskId: 't', cid: fileCid, filePath, callbackUrl: 'http://unused', metaCoreUrl, existingMeta }, async (p) => { seen.push(p); });
        return seen[0];
    };

    beforeAll(async () => {
        core = await startFakeCore();
        core.files.set(`${dir}/${videoName}`, video);
        core.files.set(`${dir}/Show - S01E02.mkv`, fakeVideo(2048, 9));
        for (const [name, data] of Object.entries(sidecars)) core.files.set(`${dir}/${name}`, data);
        process.env.WEBDAV_URL = core.webdavUrl;

        // The .srt and .fr.forced.srt are indexed already; the .ass is not.
        core.records.set(cid('Show - S01E01.srt'), { fileType: 'subtitle', extension: 'srt' });
        core.records.set(cid('Show - S01E01.fr.forced.srt'), { fileType: 'subtitle', extension: 'srt', videos: videoCid });
        core.records.set(videoCid, { fileType: 'video', extension: 'mkv', subtitles: `bagacbabaelegacy,${cid('Show - S01E01.srt')}` });
    });

    afterAll(async () => {
        delete process.env.WEBDAV_URL;
        await core.close();
    });

    it('video run: links every sidecar under its language and migrates the legacy csv', async () => {
        // Nested form, as meta-sort's /meta serves it.
        const result = await run(videoCid, `/files${dir}/${videoName}`, {
            fileType: 'video',
            extension: 'mkv',
            subtitles: `bagacbabaelegacy,${cid('Show - S01E01.srt')}`,
        });
        expect(result.status).toBe('completed');

        const v = core.records.get(videoCid)!;
        expect(v.subtitles).toBeUndefined();
        expect(Object.keys(v).filter((k) => k.startsWith('subtitle')).sort()).toEqual([
            `subtitleLanguages/eng`,
            `subtitleLanguages/fre`,
            `subtitles/eng/${cid('Show - S01E01.eng.ass')}`,
            `subtitles/eng/${cid('Show - S01E01.srt')}`,
            `subtitles/fre/${cid('Show - S01E01.fr.forced.srt')}`,
            'subtitles/und/bagacbabaelegacy',
        ].sort());

        expect(core.records.get(cid('Show - S01E01.srt'))).toEqual({
            fileType: 'subtitle', extension: 'srt', [`videos/${videoCid}`]: 'true', subtitleLanguage: 'eng',
        });
        // Legacy `videos` scalar converted to the key-set.
        expect(core.records.get(cid('Show - S01E01.fr.forced.srt'))).toEqual({
            fileType: 'subtitle', extension: 'srt', [`videos/${videoCid}`]: 'true', subtitleLanguage: 'fre',
        });
        // Not indexed yet: no stub record.
        expect(core.records.has(cid('Show - S01E01.eng.ass'))).toBe(false);
        // Not sidecars of this video.
        expect(JSON.stringify(v)).not.toContain(cid('Show - S01E01.Extended.eng.srt'));
        expect(JSON.stringify(v)).not.toContain(cid('Show - S01E02.srt'));
    });

    it('video run again over the updated record writes nothing to it', async () => {
        const before = writesTo(core, videoCid).length;
        const result = await run(videoCid, `/files${dir}/${videoName}`, core.records.get(videoCid)!);
        expect(result.status).toBe('completed');
        expect(writesTo(core, videoCid).length).toBe(before);
    });

    it('subtitle run: links a late-indexed sidecar onto the video from its side', async () => {
        const assCid = cid('Show - S01E01.eng.ass');
        core.records.set(assCid, { fileType: 'subtitle', extension: 'ass' });
        const result = await run(assCid, `/files${dir}/Show - S01E01.eng.ass`, { fileType: 'subtitle', extension: 'ass' });
        expect(result.status).toBe('completed');
        expect(core.records.get(assCid)).toMatchObject({ [`videos/${videoCid}`]: 'true', subtitleLanguage: 'eng' });
        expect(core.records.get(videoCid)![`subtitles/eng/${assCid}`]).toBe('true');
    });

    it('subtitle run: an unsuffixed sidecar gets its language from its text', async () => {
        const srtCid = cid('Show - S01E01.srt');
        core.records.set(srtCid, { fileType: 'subtitle', extension: 'srt' });
        const result = await run(srtCid, `/files${dir}/Show - S01E01.srt`, { fileType: 'subtitle', extension: 'srt' });
        expect(result.status).toBe('completed');
        expect(core.records.get(srtCid)).toMatchObject({ subtitleLanguage: 'eng', [`videos/${videoCid}`]: 'true' });
    });

    it('subtitle run: one file, one language — a stale leaf for the same cid is removed', async () => {
        const frCid = cid('Show - S01E01.fr.forced.srt');
        core.records.get(videoCid)![`subtitles/und/${frCid}`] = 'true';
        const result = await run(frCid, `/files${dir}/Show - S01E01.fr.forced.srt`, core.records.get(frCid)!);
        expect(result.status).toBe('completed');
        expect(core.records.get(videoCid)![`subtitles/und/${frCid}`]).toBeUndefined();
        expect(core.records.get(videoCid)![`subtitles/fre/${frCid}`]).toBe('true');
    });

    it('a subtitle in a plugin output folder takes its language from its name, no sibling search', async () => {
        const data = Buffer.from(FRENCH_SRT + '\n\n\n\n'); // distinct bytes from the watch-folder sidecar
        const subCid = computeMidHash256FromBuffer(data);
        const p = '/plugin/subtitle-extractor/Show[bagvid]_subtitle.s5.ger.srt'; // name wins over text
        core.files.set(p, data);
        const result = await run(subCid, `/files${p}`, { fileType: 'subtitle' });
        expect(result.status).toBe('completed');
        expect(core.records.get(subCid)).toEqual({ subtitleLanguage: 'ger' });
    });

    it('still runs on a subtitle file the classifier left as other/undefined', async () => {
        const data = Buffer.from(ENGLISH_ASS + '\n');
        const subCid = computeMidHash256FromBuffer(data);
        const p = '/plugin/subtitle-extractor/Show[bagvid]_subtitle.s9.ita.ass';
        core.files.set(p, data);
        const other = await run(subCid, `/files${p}`, { fileType: 'other', extension: 'ass' });
        expect(other.status).toBe('completed');
        expect(core.records.get(subCid)).toEqual({ subtitleLanguage: 'ita' });

        const untyped = await run('bagtxt', '/files/watch/Show/notes.srt', { fileType: 'undefined' });
        expect(untyped.status).not.toBe('skipped');
    });

    it('isUnclassifiedSubtitle only rescues subtitle extensions', () => {
        expect(isUnclassifiedSubtitle({ fileType: 'other', extension: 'ASS' }, '/files/x.ass')).toBe(true);
        expect(isUnclassifiedSubtitle({ fileType: 'undefined' }, '/files/x.srt')).toBe(true);
        expect(isUnclassifiedSubtitle({}, '/files/x.vtt')).toBe(true);
        expect(isUnclassifiedSubtitle({ fileType: 'other', extension: 'txt' }, '/files/x.txt')).toBe(false);
        expect(isUnclassifiedSubtitle({ fileType: 'document', extension: 'srt' }, '/files/x.srt')).toBe(false);
    });

    it('skips files that are neither video nor subtitle', async () => {
        const result = await run('bagimg', '/files/watch/a.jpg', { fileType: 'image' });
        expect(result).toMatchObject({ status: 'skipped', reason: 'Not a video or subtitle file' });
    });

    it('fails the task when meta-core rejects a write', async () => {
        const fresh = fakeVideo(4096, 11);
        const freshCid = computeMidHash256FromBuffer(fresh);
        core.files.set('/watch/Other/Film.mkv', fresh);
        core.files.set('/watch/Other/Film.en.srt', Buffer.from(ENGLISH_SRT));
        core.failPatch = true;
        try {
            const result = await run(freshCid, '/files/watch/Other/Film.mkv', { fileType: 'video' });
            expect(result.status).toBe('failed');
            expect(result.error).toContain('meta-core write failed');
        } finally {
            core.failPatch = false;
        }
    });

    it('fails when no WebDAV endpoint can be resolved', async () => {
        const saved = process.env.WEBDAV_URL;
        delete process.env.WEBDAV_URL;
        try {
            const result = await run(videoCid, `/files${dir}/${videoName}`, { fileType: 'video' }, 'http://127.0.0.1:9');
            expect(result).toMatchObject({ status: 'failed', error: 'No WebDAV endpoint available' });
        } finally {
            process.env.WEBDAV_URL = saved;
        }
    });
});
