/**
 * Subtitle Plugin
 * Processes subtitle files and links them to videos
 */

import { readFile, access, readdir } from 'fs/promises';
import { dirname, basename, extname, join } from 'path';
import { franc } from 'franc-min';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';

export const manifest: PluginManifest = {
    id: 'subtitle',
    name: 'Subtitle Processor',
    version: '1.0.0',
    description: 'Processes subtitle files and links them to videos',
    author: 'MetaMesh',
    dependencies: ['file-info'],
    priority: 45,
    color: '#00BCD4',
    defaultQueue: 'fast',
    timeout: 30000,
    schema: {
        subtitleLanguage: { label: 'Subtitle Language', type: 'string', readonly: true },
        videos: { label: 'Linked Videos', type: 'array', readonly: true },
        subtitles: { label: 'Linked Subtitles', type: 'array', readonly: true },
    },
    config: {},
};

const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub']);

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    try {
        const { cid, filePath, existingMeta } = request;
        const fileType = existingMeta?.fileType;

        if (fileType === 'subtitle') {
            // For subtitle files: detect language and find sibling videos
            try {
                const content = await readFile(filePath, { encoding: 'utf8', flag: 'r' });
                const sample = content.slice(0, 4096);
                const lang = franc(sample);
                if (lang && lang !== 'und') {
                    await metaCore.setProperty(cid, 'subtitleLanguage', lang);
                }
            } catch {
                // Ignore read errors
            }

            // Find sibling videos
            const dir = dirname(filePath);
            const baseName = basename(filePath, extname(filePath));
            try {
                const files = await readdir(dir);
                for (const file of files) {
                    const ext = extname(file).slice(1).toLowerCase();
                    if (VIDEO_EXTENSIONS.has(ext)) {
                        const videoBase = basename(file, extname(file));
                        // Check if video name matches subtitle base name
                        if (videoBase === baseName || baseName.startsWith(videoBase)) {
                            // We don't have CID for sibling, just note the relationship
                            await metaCore.setProperty(cid, 'linkedVideoName', file);
                        }
                    }
                }
            } catch {
                // Ignore directory read errors
            }
        } else if (fileType === 'video') {
            // For video files: find sibling subtitles
            const extension = existingMeta?.extension || '';
            for (const subExt of ['srt', 'ass', 'ssa', 'vtt']) {
                const subPath = filePath.replace(new RegExp(`\\.${extension}$`, 'i'), `.${subExt}`);
                if (await fileExists(subPath)) {
                    await metaCore.setProperty(cid, `subtitleFile/${subExt}`, basename(subPath));
                }
            }
        }

        await sendCallback({
            taskId: request.taskId,
            status: 'completed',
            duration: Date.now() - startTime,
        });
    } catch (error) {
        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
