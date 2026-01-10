/**
 * Subtitle Plugin
 *
 * For subtitle files: finds sibling video files and detects language.
 * For video files: finds sibling subtitle files.
 *
 * Matches old SubtitleProcessor output:
 * - For subtitle files: videos (add CID), subtitleLanguage
 * - For video files: subtitles (add CID)
 */

import { readFile, access, open } from 'fs/promises';
import { dirname, extname } from 'path';
import { franc } from 'franc-min';
import { FileType, getSiblingFiles } from '@metazla/filename-tools';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';

const fileType = new FileType();

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

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Read first N bytes of a file
 */
async function readFirstData(filePath: string, encoding: BufferEncoding = 'utf8', size = 1024): Promise<string> {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        return buffer.toString(encoding);
    } finally {
        await handle.close();
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
        const currentFileType = existingMeta?.fileType;

        if (currentFileType === 'subtitle') {
            await processSubtitleFile(metaCore, cid, filePath);
        } else if (currentFileType === 'video') {
            await processVideoFile(metaCore, cid, filePath, existingMeta);
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

/**
 * Process subtitle file: find sibling videos and detect language
 */
async function processSubtitleFile(
    metaCore: MetaCoreClient,
    cid: string,
    filePath: string
): Promise<void> {
    try {
        // Find sibling video files
        const siblings = await getSiblingFiles(filePath);

        for (const siblingPath of siblings) {
            const siblingType = fileType.getFileTypeFromExtension(siblingPath);
            if (siblingType === 'video') {
                try {
                    const videoCid = await metaCore.computeFileCID(siblingPath);
                    if (videoCid) {
                        await metaCore.addToSet(cid, 'videos', videoCid);
                    }
                } catch (e) {
                    console.debug(`[subtitle] Could not get CID for video: ${siblingPath}`);
                }
            }
        }

        // Detect subtitle language by reading first 4KB
        try {
            const content = await readFirstData(filePath, 'utf8', 4096);
            const detectedLang = franc(content);
            if (detectedLang && detectedLang !== 'und') {
                await metaCore.setProperty(cid, 'subtitleLanguage', detectedLang);
            }
        } catch (e) {
            console.debug(`[subtitle] Could not detect language for: ${filePath}`);
        }

        console.log(`[subtitle] Processed subtitle file: ${filePath}`);
    } catch (error) {
        console.error(`[subtitle] Error processing subtitle file ${filePath}:`, error);
    }
}

/**
 * Process video file: find sibling subtitle files
 */
async function processVideoFile(
    metaCore: MetaCoreClient,
    cid: string,
    filePath: string,
    existingMeta?: Record<string, string>
): Promise<void> {
    try {
        const extension = existingMeta?.extension || '';
        const srtPath = filePath.replace(new RegExp(`\\.${extension}$`, 'i'), '.srt');

        // Check for .srt subtitle
        if (await fileExists(srtPath)) {
            try {
                const subtitleCid = await metaCore.computeFileCID(srtPath);
                if (subtitleCid) {
                    await metaCore.addToSet(cid, 'subtitles', subtitleCid);
                }
            } catch (e) {
                console.debug(`[subtitle] Could not get CID for subtitle: ${srtPath}`);
            }
        }

        console.log(`[subtitle] Checked subtitles for video: ${filePath}`);
    } catch (error) {
        console.error(`[subtitle] Error finding subtitles for ${filePath}:`, error);
    }
}
