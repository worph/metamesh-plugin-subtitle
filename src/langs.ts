/**
 * Language code normalisation — the `lang3` vocabulary meta-watch reads.
 *
 * Port of meta-watch's `MW_LANG.toLang3` (packages/meta-watch/ui/js/lang-codes.js),
 * the same normaliser the `language` plugin copied. Every spelling folds to
 * **ISO 639-2/B** — `fre` not `fra`, `ger` not `deu`, `chi` not `zho` — because
 * that is what meta-watch writes (`subtitles/fre/<cid>`, routes/subtitles.rs)
 * and what its readers compare against:
 *
 *   ISO 639-1     "fr"     -> fre
 *   ISO 639-2/B   "fre"    -> fre
 *   ISO 639-2/T   "fra"    -> fre     (MP4 `mdhd` speaks T, Matroska speaks B)
 *   BCP-47        "pt-BR"  -> por     (primary subtag only)
 *
 * One deliberate difference: "no language" is `und`, not "" — the code becomes a
 * key segment (`subtitles/und/<cid>`, METADATA_KEYS.md §8) and `und` is the
 * registry's spelling for undetermined.
 *
 * Copied, not imported: plugins are independent submodules. This file is
 * byte-identical in metamesh-plugin-subtitle and metamesh-plugin-subtitle-extractor.
 */

// Canonical table keyed by 639-2/B: display name (lowercased for filename
// matching) and the 639-1 code that folds into it.
const LANGS: Record<string, { name: string; a1?: string }> = {
    eng: { name: 'english', a1: 'en' },
    fre: { name: 'french', a1: 'fr' },
    ger: { name: 'german', a1: 'de' },
    spa: { name: 'spanish', a1: 'es' },
    ita: { name: 'italian', a1: 'it' },
    por: { name: 'portuguese', a1: 'pt' },
    dut: { name: 'dutch', a1: 'nl' },
    swe: { name: 'swedish', a1: 'sv' },
    nor: { name: 'norwegian', a1: 'no' },
    dan: { name: 'danish', a1: 'da' },
    fin: { name: 'finnish', a1: 'fi' },
    ice: { name: 'icelandic', a1: 'is' },
    pol: { name: 'polish', a1: 'pl' },
    cze: { name: 'czech', a1: 'cs' },
    slo: { name: 'slovak', a1: 'sk' },
    slv: { name: 'slovenian', a1: 'sl' },
    hun: { name: 'hungarian', a1: 'hu' },
    rum: { name: 'romanian', a1: 'ro' },
    bul: { name: 'bulgarian', a1: 'bg' },
    rus: { name: 'russian', a1: 'ru' },
    ukr: { name: 'ukrainian', a1: 'uk' },
    bel: { name: 'belarusian', a1: 'be' },
    srp: { name: 'serbian', a1: 'sr' },
    hrv: { name: 'croatian', a1: 'hr' },
    bos: { name: 'bosnian', a1: 'bs' },
    mac: { name: 'macedonian', a1: 'mk' },
    alb: { name: 'albanian', a1: 'sq' },
    gre: { name: 'greek', a1: 'el' },
    tur: { name: 'turkish', a1: 'tr' },
    heb: { name: 'hebrew', a1: 'he' },
    ara: { name: 'arabic', a1: 'ar' },
    per: { name: 'persian', a1: 'fa' },
    urd: { name: 'urdu', a1: 'ur' },
    hin: { name: 'hindi', a1: 'hi' },
    ben: { name: 'bengali', a1: 'bn' },
    tam: { name: 'tamil', a1: 'ta' },
    tel: { name: 'telugu', a1: 'te' },
    mal: { name: 'malayalam', a1: 'ml' },
    kan: { name: 'kannada', a1: 'kn' },
    mar: { name: 'marathi', a1: 'mr' },
    guj: { name: 'gujarati', a1: 'gu' },
    pan: { name: 'punjabi', a1: 'pa' },
    nep: { name: 'nepali', a1: 'ne' },
    sin: { name: 'sinhala', a1: 'si' },
    tha: { name: 'thai', a1: 'th' },
    lao: { name: 'lao', a1: 'lo' },
    khm: { name: 'khmer', a1: 'km' },
    bur: { name: 'burmese', a1: 'my' },
    vie: { name: 'vietnamese', a1: 'vi' },
    ind: { name: 'indonesian', a1: 'id' },
    may: { name: 'malay', a1: 'ms' },
    tgl: { name: 'tagalog', a1: 'tl' },
    fil: { name: 'filipino' },
    jpn: { name: 'japanese', a1: 'ja' },
    kor: { name: 'korean', a1: 'ko' },
    chi: { name: 'chinese', a1: 'zh' },
    mon: { name: 'mongolian', a1: 'mn' },
    kaz: { name: 'kazakh', a1: 'kk' },
    uzb: { name: 'uzbek', a1: 'uz' },
    aze: { name: 'azerbaijani', a1: 'az' },
    geo: { name: 'georgian', a1: 'ka' },
    arm: { name: 'armenian', a1: 'hy' },
    est: { name: 'estonian', a1: 'et' },
    lav: { name: 'latvian', a1: 'lv' },
    lit: { name: 'lithuanian', a1: 'lt' },
    cat: { name: 'catalan', a1: 'ca' },
    glg: { name: 'galician', a1: 'gl' },
    baq: { name: 'basque', a1: 'eu' },
    wel: { name: 'welsh', a1: 'cy' },
    gle: { name: 'irish', a1: 'ga' },
    afr: { name: 'afrikaans', a1: 'af' },
    swa: { name: 'swahili', a1: 'sw' },
    amh: { name: 'amharic', a1: 'am' },
    zul: { name: 'zulu', a1: 'zu' },
    lat: { name: 'latin', a1: 'la' },
    epo: { name: 'esperanto', a1: 'eo' },
    yid: { name: 'yiddish', a1: 'yi' },
    jav: { name: 'javanese', a1: 'jv' },
    mul: { name: 'multiple' },
};

// ISO 639-2/T -> 639-2/B: the only codes where the two standards disagree.
const T2B: Record<string, string> = {
    sqi: 'alb', hye: 'arm', eus: 'baq', mya: 'bur', ces: 'cze',
    zho: 'chi', cym: 'wel', deu: 'ger', nld: 'dut', ell: 'gre', fas: 'per',
    fra: 'fre', kat: 'geo', isl: 'ice', mkd: 'mac', msa: 'may',
    ron: 'rum', slk: 'slo',
};

// "This track has no language" spellings.
const NONE = new Set(['und', 'zxx', 'mis', 'unknown', 'none']);

// 639-1 -> 639-2/B, from the table plus legacy two-letter codes.
const A1: Record<string, string> = { nb: 'nor', nn: 'nor', iw: 'heb', in: 'ind', ji: 'yid', jw: 'jav' };
const NAMES: Record<string, string> = {};
for (const [b, entry] of Object.entries(LANGS)) {
    if (entry.a1) A1[entry.a1] = b;
    NAMES[entry.name] = b;
}

/**
 * franc-min answers in ISO 639-3 individual-language codes; a few of them are
 * not 639-2 codes at all (Mandarin `cmn` is 639-2 `chi`). Folded before toLang3.
 */
const FRANC_TO_639_2: Record<string, string> = {
    cmn: 'chi', arb: 'ara', pes: 'per', swh: 'swa', uzn: 'uzb', zlm: 'may',
    npi: 'nep', azj: 'aze', plt: 'mlg', pbu: 'pus', ckb: 'kur', fuv: 'ful', qug: 'que',
};

/** Canonical lang3 (ISO 639-2/B) for any code; `und` when there is none. */
export function toLang3(code: unknown): string {
    const s = String(code ?? '').trim().toLowerCase();
    if (!s) return 'und';
    if (NAMES[s]) return NAMES[s];
    const p = s.split(/[-_]/)[0];
    if (NONE.has(p)) return 'und';
    if (p.length === 2) return A1[p] ?? 'und';
    if (p.length === 3 && /^[a-z]{3}$/.test(p)) return T2B[p] ?? p;
    return 'und';
}

/** lang3 for a franc-min result (`und` stays `und`). */
export function francToLang3(code: string): string {
    return toLang3(FRANC_TO_639_2[code] ?? code);
}

/**
 * Strict variant for filename tokens (`video.fr.srt`, `video.English.srt`):
 * only a token that is recognisably a language resolves, so `S01`, `x264` or
 * `Extended` never read as one. Returns null for anything else.
 */
export function languageToken(token: string): string | null {
    const t = token.trim().toLowerCase();
    if (!t) return null;
    if (NAMES[t]) return NAMES[t];
    if (t === 'und') return 'und';
    const p = t.split(/[-_]/)[0];
    if (p !== t && !/^[a-z]{2,3}[-_][a-z0-9]{2,8}$/.test(t)) return null;
    if (p.length === 2) return A1[p] ?? null;
    if (p.length === 3) {
        if (LANGS[p]) return p;
        if (T2B[p]) return T2B[p];
    }
    return null;
}
