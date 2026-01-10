# MetaMesh Plugin: Subtitle

A MetaMesh plugin that processes subtitle files and links them to videos.

## Description

This plugin handles subtitle file processing:

**For subtitle files (`.srt`, `.ass`, `.ssa`, `.vtt`):**
- Detects subtitle language using content analysis
- Finds sibling video files with matching names

**For video files:**
- Discovers associated subtitle files in the same directory

## Metadata Fields

| Field | Description |
|-------|-------------|
| `subtitleLanguage` | Detected language of subtitle content |
| `linkedVideoName` | Name of associated video file |
| `subtitleFile/{ext}` | Associated subtitle filename by extension |

## Dependencies

- Requires `file-info` plugin to run first

## Configuration

No configuration required.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/manifest` | GET | Plugin manifest |
| `/configure` | POST | Update configuration |
| `/process` | POST | Process a file |

## Running Locally

```bash
npm install
npm run build
npm start
```

## Docker

```bash
docker build -t metamesh-plugin-subtitle .
docker run -p 8080:8080 metamesh-plugin-subtitle
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |

## License

MIT
