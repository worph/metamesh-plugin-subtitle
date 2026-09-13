# MetaMesh Plugin: Subtitle

Links subtitle **sidecar** files to the video they sit next to, in both directions, and determines each sidecar's language.

## What counts as a sidecar

`<video basename>.<ext>` or `<video basename>.<qualifiers>.<ext>` (case-insensitive), `<ext>` in `srt`, `ass`, `ssa`, `vtt`, where every qualifier is a language (`en`, `eng`, `fre`, `pt-BR`, `English`) or a flag (`forced`, `sdh`, `cc`, `hi`, `default`, `full`, `signs`, `songs`):

- `Movie.srt`, `Movie.eng.srt`, `Movie.en.srt`, `Movie.fr.forced.srt` → sidecars of `Movie.mkv`
- `Movie.Extended.eng.srt` → not a sidecar of `Movie.mkv`

Language: the qualifier when present, else a `franc-min` sniff of the subtitle text (timecodes and ASS markup stripped), else `und`. Codes are ISO 639-2/B (`fre`, `ger`, `chi`), normalised the same way meta-watch does. `hi` means hearing-impaired, not Hindi (use `hin`).

## What it writes (METADATA_KEYS.md §8)

| Record | Key | Value |
|--------|-----|-------|
| video | `subtitles/<lang3>/<subCid>` | `"true"` |
| video | `subtitleLanguages/<lang3>` | `"true"` (not for `und`) |
| subtitle | `videos/<videoCid>` | `"true"` |
| subtitle | `subtitleLanguage` | `<lang3>` (not for `und`) |

Each run writes its own record in full and the other record only if it already exists, so the result is the same whichever file the watcher processes first. Writes are one `PATCH` of only-new keys; a failed write fails the task. Legacy comma-joined `subtitles` / `videos` scalars are migrated to the key-set.

## File access

WebDAV only (the container has no `/files` mount): directory listing, size and bytes come from the meta-core that drove the task (`/urls` → `webdavUrlInternal`; `WEBDAV_URL` overrides). CIDs are midhash256 computed from one ≤1 MiB Range read.

## Tests

```bash
pnpm install && (cd node_modules/@metazla/filename-tools && pnpm install && pnpm run build) && pnpm test
./test.sh   # in Docker
```

## License

MIT
