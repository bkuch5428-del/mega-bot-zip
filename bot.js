/**
 * MEGA Downloader Telegram Bot
 * Production-ready build for Render Free Web Service
 */

'use strict';

const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
require('dotenv').config();

// ─── Global crash guards ────────────────────────────────────────────────────
// These MUST come first so no throw can escape the process.

process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException at ${new Date().toISOString()}:`);
    console.error(err.stack || err);
    // Do NOT exit – keep the bot running.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[FATAL] unhandledRejection at ${new Date().toISOString()}:`);
    console.error('Promise:', promise);
    console.error('Reason:', reason instanceof Error ? reason.stack : reason);
    // Do NOT exit – keep the bot running.
});

// ─── Render health-check HTTP server ────────────────────────────────────────
// Render Free Web Service requires a port to be open or it will kill the dyno.
const PORT = process.env.PORT || 3000;
const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});
healthServer.listen(PORT, () => {
    log('INFO', `Health-check server listening on port ${PORT}`);
});
healthServer.on('error', (err) => {
    log('WARN', `Health server error: ${err.message}`);
});

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level, message, extra) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}`;
    if (level === 'ERROR') {
        console.error(line, extra !== undefined ? extra : '');
    } else {
        console.log(line, extra !== undefined ? extra : '');
    }
}

// ─── Telegram client setup ───────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
});

let mtprotoStarted = false;
async function startMtproto() {
    if (!mtprotoStarted) {
        log('INFO', '🔄 Starting MTProto Client...');
        await client.start({ botAuthToken: process.env.BOT_TOKEN });
        mtprotoStarted = true;
        log('INFO', '✅ MTProto Client Started!');
    }
}

let botUsername = '';

// ─── Telegram API helpers ────────────────────────────────────────────────────

/**
 * Returns true for errors that mean "this message can't be edited any more"
 * and should be silently swallowed.
 */
function isIgnorableEditError(err) {
    const msg = err && (err.message || '');
    return (
        msg.includes('message to edit not found') ||
        msg.includes('message is not modified') ||
        msg.includes('MESSAGE_ID_INVALID') ||
        msg.includes('Bad Request: message to edit not found') ||
        msg.includes('Bad Request: message is not modified')
    );
}

/**
 * Safely edit a Telegram message.
 * - Swallows "not found" / "not modified" errors silently.
 * - Retries once after waiting if Telegram returns 429 Too Many Requests.
 * - Falls back to plain text if Markdown parse fails.
 */
async function safeEditMessage(telegram, chatId, messageId, text, parseMode = 'Markdown') {
    if (!messageId) return;

    const attemptEdit = async (pm) => {
        try {
            await telegram.editMessageText(chatId, messageId, null, text, pm ? { parse_mode: pm } : {});
        } catch (err) {
            if (isIgnorableEditError(err)) return; // silent

            const retryAfter = err.parameters && err.parameters.retry_after;
            if (retryAfter || (err.message && err.message.includes('429'))) {
                const wait = ((retryAfter || 5) + 1) * 1000;
                log('WARN', `429 Too Many Requests – waiting ${wait}ms before retry`);
                await sleep(wait);
                try {
                    await telegram.editMessageText(chatId, messageId, null, text, pm ? { parse_mode: pm } : {});
                } catch (retryErr) {
                    if (!isIgnorableEditError(retryErr)) {
                        log('WARN', `Edit retry failed: ${retryErr.message}`);
                    }
                }
                return;
            }

            if (pm && (err.message || '').includes('parse')) {
                // Markdown parse error – fall back to plain text
                await attemptEdit(null);
                return;
            }

            log('WARN', `Cannot edit message: ${err.message}`);
        }
    };

    await attemptEdit(parseMode);
}

/**
 * Safely delete a Telegram message, ignoring all errors.
 */
async function safeDeleteMessage(telegram, chatId, messageId) {
    if (!messageId) return;
    try {
        await telegram.deleteMessage(chatId, messageId);
    } catch (err) {
        log('WARN', `Cannot delete message ${messageId}: ${err.message}`);
    }
}

/**
 * Safely send a reply, falling back to plain text on Markdown errors.
 */
async function safeReply(ctx, text, extra = {}) {
    try {
        return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
    } catch (err) {
        if ((err.message || '').includes('parse')) {
            try {
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\]/g, ''), extra);
            } catch (e2) {
                log('ERROR', `Cannot send reply: ${e2.message}`);
            }
        } else {
            log('ERROR', `Cannot send reply: ${err.message}`);
        }
        return null;
    }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isVideoFile(filename) {
    const exts = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv'];
    return exts.includes(path.extname(filename).toLowerCase());
}

function isImageFile(filename) {
    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg', '.ico'];
    return exts.includes(path.extname(filename).toLowerCase());
}

function isAudioFile(filename) {
    const exts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus'];
    return exts.includes(path.extname(filename).toLowerCase());
}

function cleanMegaLink(link) {
    if (!link) return null;
    let cleaned = link.trim().replace(/\s+/g, '').replace(/[<>]/g, '');
    if (cleaned.includes('mega.nz')) {
        if (!cleaned.startsWith('http')) cleaned = 'https://' + cleaned;
        return cleaned;
    }
    return null;
}

function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            log('INFO', `🗑  Cleaned up file: ${path.basename(filePath)}`);
        }
    } catch (err) {
        log('WARN', `Cleanup error (file): ${err.message}`);
    }
}

function cleanupFolder(folderPath) {
    try {
        if (folderPath && fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            log('INFO', `🗑  Cleaned up folder: ${folderPath}`);
        }
    } catch (err) {
        log('WARN', `Cleanup error (folder): ${err.message}`);
    }
}

// ─── File sending with retry ─────────────────────────────────────────────────

const MAX_SEND_RETRIES = 3;
const RETRY_BASE_DELAY = 3000; // ms

async function sendTelegramFile(ctx, filePath, fileName, fileSize, progressCallback) {
    const caption = `${fileName}\nSize: ${formatBytes(fileSize)}`;
    const chatId = ctx.chat.id;
    const forceDocument = !isVideoFile(fileName) && !isImageFile(fileName) && !isAudioFile(fileName);
    let captionPrefix = '📄';
    if (isVideoFile(fileName)) captionPrefix = '🎬';
    else if (isImageFile(fileName)) captionPrefix = '🖼️';
    else if (isAudioFile(fileName)) captionPrefix = '🎵';

    log('INFO', `📤 Upload start: ${fileName} (${formatBytes(fileSize)})`);

    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
        try {
            await startMtproto();
            const result = await client.sendFile(chatId, {
                file: filePath,
                caption: isVideoFile(fileName) ? '' : `${captionPrefix} ${caption}`,
                forceDocument,
                replyTo: ctx.message ? ctx.message.message_id : undefined,
                progressCallback,
            });
            log('INFO', `✅ Upload complete: ${fileName}`);
            return result;
        } catch (err) {
            const isNetwork = err.message && (
                err.message.includes('ECONNRESET') ||
                err.message.includes('ETIMEDOUT') ||
                err.message.includes('ENOTFOUND') ||
                err.message.includes('socket hang up') ||
                err.message.includes('network') ||
                err.message.includes('timeout')
            );
            const is429 = err.message && err.message.includes('429');

            if (attempt < MAX_SEND_RETRIES && (isNetwork || is429)) {
                const delay = is429
                    ? ((err.parameters && err.parameters.retry_after || 10) + 1) * 1000
                    : RETRY_BASE_DELAY * attempt;
                log('WARN', `⚠️  Upload attempt ${attempt}/${MAX_SEND_RETRIES} failed for ${fileName}: ${err.message}. Retrying in ${delay}ms...`);
                await sleep(delay);
                continue;
            }

            log('ERROR', `❌ Upload failed for ${fileName} after ${attempt} attempt(s): ${err.message}`, err.stack);
            throw err;
        }
    }
}

// ─── Progress updater ────────────────────────────────────────────────────────
// Throttled to at most once every PROGRESS_INTERVAL ms to avoid 429 errors.

const PROGRESS_INTERVAL = 7000; // 7 seconds

function createProgressUpdater(editStatusFunc, actionPrefix, totalFiles = 1) {
    let lastUpdate = 0;
    let lastProgressText = '';
    let pendingUpdate = null;

    return async (progress, fileName, fileSize, fileIndex = 1) => {
        const now = Date.now();
        // Always send the final 100 % update; otherwise throttle.
        if (progress < 1 && now - lastUpdate < PROGRESS_INTERVAL) return;

        const filledLength = Math.round(10 * progress);
        const bar = '▓'.repeat(filledLength) + '░'.repeat(10 - filledLength);
        const percentage = (progress * 100).toFixed(1);
        const currentBytes = progress * fileSize;

        const fileStatus = totalFiles > 1
            ? `\n*File:* \`${fileName}\` [${fileIndex}/${totalFiles}]`
            : `\n*Name:* \`${fileName}\``;

        const prefix = typeof actionPrefix === 'function' ? actionPrefix() : actionPrefix;
        const progressText = `${prefix}${fileStatus}\n*Progress:* ${percentage}%\n*Size:* ${formatBytes(currentBytes)} / ${formatBytes(fileSize)}\n[${bar}]`;

        if (lastProgressText === progressText) return;

        lastUpdate = now;
        lastProgressText = progressText;

        // Fire-and-forget – errors are handled inside safeEditMessage.
        if (pendingUpdate) return; // don't stack calls
        pendingUpdate = editStatusFunc(progressText).finally(() => { pendingUpdate = null; });
    };
}

// ─── MEGA download ───────────────────────────────────────────────────────────

async function getAllFilesFromFolder(folder) {
    const files = [];
    try {
        if (folder.children && Array.isArray(folder.children)) {
            for (const child of folder.children) {
                if (child.directory) {
                    files.push(...await getAllFilesFromFolder(child));
                } else {
                    files.push(child);
                }
            }
        } else {
            await new Promise((resolve, reject) => {
                const load = folder.loadChildren || folder.getChildren;
                if (typeof load === 'function') {
                    load.call(folder, (err, children) => {
                        if (err) reject(err);
                        else { folder.children = children; resolve(); }
                    });
                } else {
                    reject(new Error('Cannot load folder contents'));
                }
            });
            for (const child of folder.children) {
                if (child.directory) {
                    files.push(...await getAllFilesFromFolder(child));
                } else {
                    files.push(child);
                }
            }
        }
    } catch (err) {
        log('ERROR', `Error getting folder contents: ${err.message}`, err.stack);
        throw err;
    }
    return files;
}

async function downloadMegaFolder(folder, tempDir, onProgress) {
    log('INFO', `📁 Folder detected: ${folder.name}`);

    const allFiles = await getAllFilesFromFolder(folder);
    if (allFiles.length === 0) throw new Error('Folder is empty');

    log('INFO', `📊 Found ${allFiles.length} files in folder`);

    const folderDir = path.join(tempDir, folder.name);
    if (!fs.existsSync(folderDir)) fs.mkdirSync(folderDir, { recursive: true });

    const downloadedFiles = [];
    const downloadErrors = [];

    for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        const filePath = path.join(folderDir, file.name);
        const fileDir = path.dirname(filePath);

        try {
            log('INFO', `⬇️  Downloading [${i + 1}/${allFiles.length}]: ${file.name}`);
            if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

            await new Promise((resolve, reject) => {
                const writeStream = fs.createWriteStream(filePath);
                let downloadedBytes = 0;
                let stream;

                try {
                    stream = file.download();
                } catch (e) {
                    return reject(e);
                }

                stream.on('data', chunk => {
                    downloadedBytes += chunk.length;
                    if (onProgress) {
                        onProgress(downloadedBytes / (file.size || 1), file.name, file.size || 0, i + 1, allFiles.length);
                    }
                });

                stream.on('error', (err) => {
                    writeStream.destroy();
                    cleanupFile(filePath);
                    reject(err);
                });

                stream.pipe(writeStream);

                writeStream.on('finish', () => {
                    downloadedFiles.push({ path: filePath, name: file.name, size: file.size });
                    log('INFO', `✅ Downloaded: ${file.name}`);
                    resolve();
                });

                writeStream.on('error', (err) => {
                    cleanupFile(filePath);
                    reject(err);
                });
            });

        } catch (err) {
            log('ERROR', `❌ Failed to download ${file.name}: ${err.message}`);
            downloadErrors.push(`${file.name}: ${err.message}`);
            // Continue with next file – do NOT abort the whole folder.
        }
    }

    if (downloadedFiles.length === 0) throw new Error('All downloads failed');

    const totalSize = downloadedFiles.reduce((sum, f) => sum + f.size, 0);
    return {
        type: 'folder',
        folderPath: folderDir,
        files: downloadedFiles,
        fileCount: downloadedFiles.length,
        totalSize,
        errors: downloadErrors,
    };
}

async function downloadMegaFile(megaUrl, userId, onProgress) {
    log('INFO', `⬇️  Download start: ${megaUrl}`);

    const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    return new Promise((resolve, reject) => {
        let file;
        try {
            file = mega.File.fromURL(megaUrl);
        } catch (err) {
            return reject(new Error(`Invalid MEGA link: ${err.message}`));
        }

        if (!file) return reject(new Error('Could not parse MEGA URL'));

        file.loadAttributes((err) => {
            if (err) {
                log('ERROR', `❌ Error loading MEGA attributes: ${err.message}`);
                let errorMsg = `Failed to load: ${err.message}`;
                if (err.message.includes('ENOENT') || err.message.includes('not found')) {
                    errorMsg = 'File/Folder not found. Link may be expired or invalid.';
                } else if (err.message.includes('decryption')) {
                    errorMsg = 'Decryption failed. Check if your link has the correct key.';
                }
                return reject(new Error(errorMsg));
            }

            log('INFO', `✅ MEGA item loaded: ${file.name} (${formatBytes(file.size)})`);

            if (file.directory) {
                downloadMegaFolder(file, tempDir, onProgress).then(resolve).catch(reject);
            } else {
                const tempPath = path.join(tempDir, file.name);
                log('INFO', `💾 Saving to: ${tempPath}`);

                const writeStream = fs.createWriteStream(tempPath);
                let downloadedBytes = 0;
                let stream;

                try {
                    stream = file.download();
                } catch (e) {
                    return reject(new Error(`Download init failed: ${e.message}`));
                }

                stream.on('data', chunk => {
                    downloadedBytes += chunk.length;
                    if (onProgress) onProgress(downloadedBytes / (file.size || 1), file.name, file.size || 0, 1, 1);
                });

                stream.on('error', (err) => {
                    log('ERROR', `❌ Download stream error: ${err.message}`);
                    writeStream.destroy();
                    cleanupFile(tempPath);
                    reject(new Error(`Download failed: ${err.message}`));
                });

                stream.pipe(writeStream);

                writeStream.on('finish', () => {
                    log('INFO', `✅ Download complete: ${file.name}`);
                    resolve({ type: 'file', path: tempPath, name: file.name, size: file.size });
                });

                writeStream.on('error', (err) => {
                    log('ERROR', `❌ Write error: ${err.message}`);
                    cleanupFile(tempPath);
                    reject(new Error(`Failed to save file: ${err.message}`));
                });
            }
        });
    });
}

// ─── Core handler ────────────────────────────────────────────────────────────

async function processMegaLink(ctx, megaLink) {
    const userId = ctx.from ? ctx.from.id : ctx.chat.id;
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;

    log('INFO', `📩 Processing MEGA link | chat ${chatId} (${chatType}) | user ${userId}`);

    let statusMsg = null;
    const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());

    try {
        // Send initial status message
        statusMsg = await safeReply(ctx, '🔍 *Processing MEGA Link*\n\nChecking link...');

        // Wrapper for editing the status message
        const editStatus = (text) =>
            safeEditMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id, text);

        // ── Download ──────────────────────────────────────────────────────────
        const downloadUpdater = createProgressUpdater(editStatus, '⬇️ *Downloading from MEGA*');
        const result = await downloadMegaFile(megaLink, userId, downloadUpdater);

        // ── Single file ───────────────────────────────────────────────────────
        if (result.type === 'file') {
            const maxFileSize = 2000 * 1024 * 1024;

            if (result.size > maxFileSize) {
                await editStatus(`❌ *File Too Large*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n⚠️ Telegram limit is 2 GB per file.`);
                cleanupFile(result.path);
                return;
            }

            await editStatus(`✅ *File Loaded*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n📤 Sending to Telegram...`);

            try {
                const uploadUpdater = createProgressUpdater(editStatus, '📤 *Uploading to Telegram*');
                await sendTelegramFile(ctx, result.path, result.name, result.size, (progress) => {
                    uploadUpdater(progress, result.name, result.size, 1, 1);
                });

                await safeDeleteMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id);

                if (chatType !== 'private') {
                    await safeReply(ctx, '✅ *File sent successfully!*');
                }
            } catch (sendErr) {
                log('ERROR', `❌ Send failed for ${result.name}: ${sendErr.message}`, sendErr.stack);
                await editStatus(`❌ *Failed to Send*\n\n*File:* \`${result.name}\`\n*Error:* ${sendErr.message}`);
            } finally {
                cleanupFile(result.path);
            }

        // ── Folder ────────────────────────────────────────────────────────────
        } else if (result.type === 'folder') {
            const folderName = path.basename(result.folderPath);

            await editStatus(`📦 *Folder Ready*\n\n*Name:* \`${folderName}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}\n\n📤 Starting to send files...`);
            await safeDeleteMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id);
            statusMsg = null;

            await safeReply(ctx, `📁 *Folder Download Complete*\n\n*Name:* \`${folderName}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}`);

            let sentCount = 0;
            let failedCount = 0;
            const maxFileSize = 2000 * 1024 * 1024;

            let progressMsg = await safeReply(ctx, `📤 *Sending Files*\n\n✅ Sent: 0/${result.fileCount}\n❌ Failed: 0`);

            const folderUploadUpdater = createProgressUpdater(
                (text) => safeEditMessage(ctx.telegram, chatId, progressMsg && progressMsg.message_id, text),
                () => `📤 *Uploading Folder to Telegram*\n\n✅ Sent: ${sentCount}/${result.fileCount}\n❌ Failed: ${failedCount}`,
                result.files.length
            );

            for (let i = 0; i < result.files.length; i++) {
                const file = result.files[i];
                log('INFO', `📤 Queue [${i + 1}/${result.files.length}]: ${file.name}`);

                try {
                    if (file.size > maxFileSize) {
                        log('WARN', `⏭  Skipping ${file.name} – exceeds 2 GB limit`);
                        failedCount++;
                        continue;
                    }

                    await sendTelegramFile(ctx, file.path, file.name, file.size, (progress) => {
                        folderUploadUpdater(progress, file.name, file.size, i + 1);
                    });

                    sentCount++;
                    log('INFO', `✅ Sent [${sentCount}/${result.fileCount}]: ${file.name}`);

                    // Small pause between files to reduce rate-limit pressure.
                    await sleep(1500);

                } catch (fileErr) {
                    log('ERROR', `❌ Failed to send ${file.name}: ${fileErr.message}`, fileErr.stack);
                    failedCount++;
                    // Continue to the next file – never abort the whole queue.
                } finally {
                    // Release the file buffer immediately after each upload.
                    cleanupFile(file.path);
                }
            }

            await safeDeleteMessage(ctx.telegram, chatId, progressMsg && progressMsg.message_id);
            cleanupFolder(result.folderPath);

            let summary = `✅ *Folder Transfer Complete!*\n\n`;
            summary += `📁 *Folder:* \`${folderName}\`\n`;
            summary += `📊 *Total Files:* ${result.fileCount}\n`;
            summary += `✅ *Sent Successfully:* ${sentCount}\n`;
            if (failedCount > 0) summary += `❌ *Failed/Skipped:* ${failedCount}\n`;
            summary += `💾 *Total Size:* ${formatBytes(result.totalSize)}`;

            await safeReply(ctx, summary);
            log('INFO', `📊 Queue complete | sent=${sentCount} failed=${failedCount}`);
        }

    } catch (err) {
        log('ERROR', `❌ processMegaLink error: ${err.message}`, err.stack);

        const errorMessage =
            `❌ *Download Failed*\n\n` +
            `*Error:* ${err.message}\n\n` +
            `*Please check:*\n` +
            `1. Link is correct and not expired\n` +
            `2. Includes #key at the end\n` +
            `3. File/folder exists`;

        if (statusMsg) {
            await safeEditMessage(ctx.telegram, chatId, statusMsg.message_id, errorMessage);
        } else {
            await safeReply(ctx, errorMessage);
        }

    } finally {
        // Always clean up the user's temp directory.
        cleanupFolder(tempDir);
    }
}

// ─── Bot commands ─────────────────────────────────────────────────────────────

bot.start((ctx) => {
    const chatType = ctx.chat.type;
    const chatName = chatType === 'private' ? 'here' : `in this ${chatType}`;

    ctx.reply(`🤖 *MEGA Downloader Bot*

*I can download MEGA files and folders ${chatName}!*

Just send me any MEGA link and I'll download it.

*Features:*
• Works in private chats, groups, and channels
• Downloads files and folders
• Auto-detects file types
• Shows progress
• Automatic cleanup

*Supported Formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\`

*For Groups/Channels:*
1. Add me as admin
2. Give me permission to read messages
3. Send MEGA link in chat
4. I'll download and send files directly

Send me a MEGA link to get started!`, {
        parse_mode: 'Markdown'
    }).catch(err => log('WARN', `start reply error: ${err.message}`));
});

bot.help((ctx) => {
    const chatType = ctx.chat.type;

    if (chatType === 'private') {
        ctx.reply(`📖 *Help - Private Chat*

Just send me any MEGA link and I'll download it for you!

*Valid link formats:*
✅ \`https://mega.nz/file/ABC123#XYZ456\`
✅ \`https://mega.nz/folder/DEF789#UVW012\`

*Requirements:*
• Link must include #key at the end
• File size must be under 2GB for Telegram`, {
            parse_mode: 'Markdown'
        }).catch(err => log('WARN', `help reply error: ${err.message}`));
    } else {
        ctx.reply(`📖 *Help - ${chatType === 'group' ? 'Group' : 'Channel'}*

I can download MEGA files here too!

*IMPORTANT: For me to work in this ${chatType}:*
1. I must be added as admin
2. I need permission to read messages
3. I need permission to send messages/media

*How to use:*
Just send any MEGA link in chat, I'll process it automatically.

*Link formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\``, {
            parse_mode: 'Markdown'
        }).catch(err => log('WARN', `help reply error: ${err.message}`));
    }
});

bot.on('message', async (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return;

    const megaLink = cleanMegaLink(text);

    if (!megaLink) {
        if (ctx.chat.type !== 'private') {
            const username = ctx.botInfo && ctx.botInfo.username;
            if (username && text.includes(`@${username}`)) {
                await safeReply(ctx, `🤖 Hi! Send me a MEGA link to download files.\n\nExample: \`https://mega.nz/file/ABC123#XYZ456\``);
            }
        }
        return;
    }

    log('INFO', `🔍 MEGA link detected | ${ctx.chat.type} ${ctx.chat.id}`);

    // Permission check for non-private chats
    if (ctx.chat.type !== 'private') {
        try {
            const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);

            if (ctx.chat.type === 'channel') {
                if (chatMember.status !== 'administrator') {
                    log('WARN', `Bot is not admin in channel ${ctx.chat.id}`);
                    if (ctx.from) {
                        ctx.telegram.sendMessage(
                            ctx.from.id,
                            `❌ I cannot process MEGA links in this channel because I'm not an admin.\n\nPlease make me an admin with permission to read and post messages.`
                        ).catch(() => {});
                    }
                    return;
                }
                if (!chatMember.can_post_messages) {
                    log('WARN', `Bot cannot post in channel ${ctx.chat.id}`);
                    return;
                }
            }

            if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                if (chatMember.status === 'restricted' && !chatMember.can_send_messages) {
                    log('WARN', `Bot cannot send messages in group ${ctx.chat.id}`);
                    return;
                }
                if (!['administrator', 'member', 'restricted'].includes(chatMember.status)) {
                    log('WARN', `Bot has unexpected status in group ${ctx.chat.id}: ${chatMember.status}`);
                    return;
                }
            }

        } catch (err) {
            log('ERROR', `Error checking permissions in ${ctx.chat.type} ${ctx.chat.id}: ${err.message}`);
            return;
        }
    }

    await processMegaLink(ctx, megaLink);
});

bot.on('document', (ctx) => {
    if (ctx.chat.type === 'private') {
        ctx.reply('📎 Send me a MEGA link to download files!\n\nExample:\n`https://mega.nz/file/ABC123#XYZ456`', {
            parse_mode: 'Markdown'
        }).catch(err => log('WARN', `document reply error: ${err.message}`));
    }
});

// Global bot error handler – catches errors thrown by middleware/handlers.
bot.catch((err, ctx) => {
    log('ERROR', `Bot middleware error: ${err.message}`, err.stack);
    try {
        if (ctx && ctx.chat && ctx.chat.type === 'private') {
            ctx.reply('❌ An internal error occurred. Please try again.').catch(() => {});
        }
    } catch (e) {
        log('ERROR', `Failed to send error reply: ${e.message}`);
    }
});

// ─── Bot launch with retry ───────────────────────────────────────────────────

const LAUNCH_RETRY_DELAY = 5000;

async function launchWithRetry() {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            log('INFO', `🚀 Launching bot (attempt ${attempt})...`);
            const botInfo = await bot.telegram.getMe();
            botUsername = botInfo.username;
            log('INFO', `🤖 Bot username: @${botUsername}`);
            log('INFO', `🔗 Bot invite link: https://t.me/${botUsername}`);

            await bot.launch();
            log('INFO', '✅ Bot started successfully!');
            log('INFO', '👥 Working in: Private chats, Groups, Channels');
            log('INFO', `📁 Temp directory: ${os.tmpdir()}`);
            break; // Success – exit the retry loop.
        } catch (err) {
            log('ERROR', `❌ Bot launch failed (attempt ${attempt}): ${err.message}`, err.stack);
            log('INFO', `⏳ Retrying in ${LAUNCH_RETRY_DELAY / 1000}s...`);
            await sleep(LAUNCH_RETRY_DELAY);
        }
    }
}

launchWithRetry();

// ─── Graceful shutdown ───────────────────────────────────────────────────────

process.once('SIGINT', () => {
    log('INFO', '🛑 SIGINT received – shutting down...');
    bot.stop('SIGINT');
    healthServer.close();
});

process.once('SIGTERM', () => {
    log('INFO', '🛑 SIGTERM received – shutting down...');
    bot.stop('SIGTERM');
    healthServer.close();
});
