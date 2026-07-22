/**
 * MEGA Downloader Telegram Bot
 * Production-ready build for Render Free Web Service
 *
 * Folder strategy: stream one file at a time.
 *   1. Load folder file list (metadata only – no download)
 *   2. For each file: download → upload → delete temp → next
 *   At most ONE file lives on disk at any moment.
 *   Session state is persisted so a restart resumes from the last
 *   successfully uploaded file.
 */

'use strict';

const { Telegraf }      = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega   = require('megajs');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const http   = require('http');
const crypto = require('crypto');
require('dotenv').config();

// ─── Global crash guards ─────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException at ${new Date().toISOString()}:`);
    console.error(err.stack || err);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[FATAL] unhandledRejection at ${new Date().toISOString()}:`);
    console.error(reason instanceof Error ? reason.stack : reason);
});

// ─── Render health-check HTTP server ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});
healthServer.listen(PORT, () => log('INFO', `Health-check server on port ${PORT}`));
healthServer.on('error', (err) => log('WARN', `Health server error: ${err.message}`));

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, message, extra) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    if (level === 'ERROR') console.error(line, extra !== undefined ? extra : '');
    else                   console.log (line, extra !== undefined ? extra : '');
}

// ─── Telegram client setup ────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

const apiId   = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const client  = new TelegramClient(new StringSession(''), apiId, apiHash, {
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

// ─── Telegram API helpers ─────────────────────────────────────────────────────
function isIgnorableEditError(err) {
    const m = (err && err.message) || '';
    return (
        m.includes('message to edit not found') ||
        m.includes('message is not modified')   ||
        m.includes('MESSAGE_ID_INVALID')
    );
}

async function safeEditMessage(telegram, chatId, messageId, text, parseMode = 'Markdown') {
    if (!messageId) return;
    const attempt = async (pm) => {
        try {
            await telegram.editMessageText(
                chatId, messageId, null, text,
                pm ? { parse_mode: pm } : {}
            );
        } catch (err) {
            if (isIgnorableEditError(err)) return;
            const retryAfter = err.parameters && err.parameters.retry_after;
            if (retryAfter || (err.message || '').includes('429')) {
                const wait = ((retryAfter || 5) + 1) * 1000;
                log('WARN', `429 – waiting ${wait}ms`);
                await sleep(wait);
                try {
                    await telegram.editMessageText(
                        chatId, messageId, null, text,
                        pm ? { parse_mode: pm } : {}
                    );
                } catch (e2) { if (!isIgnorableEditError(e2)) log('WARN', `Edit retry: ${e2.message}`); }
                return;
            }
            if (pm && (err.message || '').includes('parse')) { await attempt(null); return; }
            log('WARN', `Cannot edit message: ${err.message}`);
        }
    };
    await attempt(parseMode);
}

async function safeDeleteMessage(telegram, chatId, messageId) {
    if (!messageId) return;
    try { await telegram.deleteMessage(chatId, messageId); }
    catch (err) { log('WARN', `Cannot delete msg ${messageId}: ${err.message}`); }
}

async function safeReply(ctx, text, extra = {}) {
    try { return await ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
    catch (err) {
        if ((err.message || '').includes('parse')) {
            try { return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\]/g, ''), extra); }
            catch (e2) { log('ERROR', `Cannot reply: ${e2.message}`); }
        } else {
            log('ERROR', `Cannot reply: ${err.message}`);
        }
        return null;
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isVideoFile(f) { return ['.mp4','.avi','.mov','.mkv','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv'].includes(path.extname(f).toLowerCase()); }
function isImageFile(f) { return ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.svg','.ico'].includes(path.extname(f).toLowerCase()); }
function isAudioFile(f) { return ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.wma','.opus'].includes(path.extname(f).toLowerCase()); }

function cleanMegaLink(link) {
    if (!link) return null;
    let c = link.trim().replace(/\s+/g, '').replace(/[<>]/g, '');
    if (!c.includes('mega.nz')) return null;
    if (!c.startsWith('http')) c = 'https://' + c;
    return c;
}

function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            log('INFO', `🗑  Deleted: ${path.basename(filePath)}`);
        }
    } catch (err) { log('WARN', `Cleanup file: ${err.message}`); }
}

function cleanupFolder(folderPath) {
    try {
        if (folderPath && fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            log('INFO', `🗑  Deleted folder: ${folderPath}`);
        }
    } catch (err) { log('WARN', `Cleanup folder: ${err.message}`); }
}

// ─── Progress updater ─────────────────────────────────────────────────────────
// Throttled to 7 s to stay well under Telegram rate limits.
const PROGRESS_INTERVAL = 7000;

function makeProgressBar(progress) {
    const filled = Math.round(10 * progress);
    return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function createProgressUpdater(editFn) {
    let lastUpdate = 0;
    let lastText   = '';
    let pending    = null;

    return (text) => {
        const now = Date.now();
        if (text === lastText) return;
        if (now - lastUpdate < PROGRESS_INTERVAL) return;
        lastUpdate = now;
        lastText   = text;
        if (pending) return;
        pending = editFn(text).finally(() => { pending = null; });
    };
}

// ─── Session state (resume on restart) ───────────────────────────────────────
// Stored in /tmp/mega-bot/sessions/<urlhash>.json
// Tracks which file names have been successfully uploaded so a restarted bot
// can skip them and continue from where it left off.

const SESSION_DIR = path.join(os.tmpdir(), 'mega-bot', 'sessions');

function sessionKey(megaUrl) {
    return crypto.createHash('md5').update(megaUrl).digest('hex').slice(0, 16);
}

function loadSession(megaUrl) {
    try {
        const p = path.join(SESSION_DIR, `${sessionKey(megaUrl)}.json`);
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) { log('WARN', `Load session: ${err.message}`); }
    return null;
}

function saveSession(megaUrl, data) {
    try {
        if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(
            path.join(SESSION_DIR, `${sessionKey(megaUrl)}.json`),
            JSON.stringify(data, null, 2), 'utf8'
        );
    } catch (err) { log('WARN', `Save session: ${err.message}`); }
}

function clearSession(megaUrl) {
    try {
        const p = path.join(SESSION_DIR, `${sessionKey(megaUrl)}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) { log('WARN', `Clear session: ${err.message}`); }
}

// ─── MEGA: load a single file or folder node (metadata only) ─────────────────
function loadMegaItem(megaUrl) {
    return new Promise((resolve, reject) => {
        let file;
        try { file = mega.File.fromURL(megaUrl); }
        catch (err) { return reject(new Error(`Invalid MEGA link: ${err.message}`)); }

        if (!file) return reject(new Error('Could not parse MEGA URL'));

        file.loadAttributes((err) => {
            if (err) {
                let msg = `Failed to load MEGA item: ${err.message}`;
                if (err.message.includes('ENOENT') || err.message.includes('not found'))
                    msg = 'File/Folder not found. Link may be expired or invalid.';
                else if (err.message.includes('decryption'))
                    msg = 'Decryption failed. Check the #key in your link.';
                return reject(new Error(msg));
            }
            resolve(file);
        });
    });
}

// ─── MEGA: collect flat file list from a folder node (metadata only) ─────────
// Returns an array of megajs File nodes. No data is downloaded here.
async function collectFolderFiles(folder) {
    const results = [];

    async function walk(node) {
        if (node.children && Array.isArray(node.children)) {
            for (const child of node.children) {
                if (child.directory) await walk(child);
                else results.push(child);
            }
        } else {
            // Children not yet loaded – load them now (metadata only).
            await new Promise((resolve, reject) => {
                const fn = node.loadChildren || node.getChildren;
                if (typeof fn !== 'function')
                    return reject(new Error('Cannot enumerate folder children'));
                fn.call(node, (err, children) => {
                    if (err) return reject(err);
                    node.children = children;
                    resolve();
                });
            });
            for (const child of node.children) {
                if (child.directory) await walk(child);
                else results.push(child);
            }
        }
    }

    await walk(folder);
    return results;
}

// ─── MEGA: download a single file node to disk (with retry) ──────────────────
const MAX_DL_RETRIES = 3;
const RETRY_BASE_MS  = 4000;

async function downloadOneFile(fileNode, destPath, onProgress) {
    for (let attempt = 1; attempt <= MAX_DL_RETRIES; attempt++) {
        cleanupFile(destPath); // remove any partial file from a previous attempt

        try {
            log('INFO', `⬇️  DL attempt ${attempt}/${MAX_DL_RETRIES}: ${fileNode.name}`);
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(destPath);
                let downloaded = 0;
                let stream;
                try { stream = fileNode.download(); }
                catch (e) { ws.destroy(); return reject(e); }

                stream.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (onProgress) onProgress(downloaded / (fileNode.size || 1));
                });
                stream.on('error', (e) => { ws.destroy(); reject(e); });
                stream.pipe(ws);
                ws.on('finish', resolve);
                ws.on('error', reject);
            });

            log('INFO', `✅ DL complete: ${fileNode.name} (${formatBytes(fileNode.size)})`);
            return; // success

        } catch (err) {
            cleanupFile(destPath);
            if (attempt < MAX_DL_RETRIES) {
                const delay = RETRY_BASE_MS * attempt;
                log('WARN', `⚠️  DL attempt ${attempt} failed for "${fileNode.name}": ${err.message}. Retry in ${delay}ms`);
                await sleep(delay);
            } else {
                throw new Error(`Download failed after ${MAX_DL_RETRIES} attempts: ${err.message}`);
            }
        }
    }
}

// ─── Telegram: upload a local file (with retry) ───────────────────────────────
const MAX_UL_RETRIES = 3;

async function sendTelegramFile(ctx, filePath, fileName, fileSize, onProgress) {
    const chatId       = ctx.chat.id;
    const forceDoc     = !isVideoFile(fileName) && !isImageFile(fileName) && !isAudioFile(fileName);
    let captionPrefix  = '📄';
    if (isVideoFile(fileName))  captionPrefix = '🎬';
    else if (isImageFile(fileName)) captionPrefix = '🖼️';
    else if (isAudioFile(fileName)) captionPrefix = '🎵';
    const caption = `${captionPrefix} ${fileName}\nSize: ${formatBytes(fileSize)}`;

    log('INFO', `📤 UL start: ${fileName} (${formatBytes(fileSize)})`);

    for (let attempt = 1; attempt <= MAX_UL_RETRIES; attempt++) {
        try {
            await startMtproto();
            const result = await client.sendFile(chatId, {
                file:             filePath,
                caption:          isVideoFile(fileName) ? '' : caption,
                forceDocument:    forceDoc,
                replyTo:          ctx.message ? ctx.message.message_id : undefined,
                progressCallback: onProgress,
            });
            log('INFO', `✅ UL complete: ${fileName}`);
            return result;

        } catch (err) {
            const retryable =
                err.message && (
                    err.message.includes('ECONNRESET')    ||
                    err.message.includes('ETIMEDOUT')     ||
                    err.message.includes('ENOTFOUND')     ||
                    err.message.includes('socket hang up')||
                    err.message.includes('timeout')       ||
                    err.message.includes('network')       ||
                    err.message.includes('429')
                );
            if (attempt < MAX_UL_RETRIES && retryable) {
                const retryAfter = err.parameters && err.parameters.retry_after;
                const delay = retryAfter
                    ? (retryAfter + 1) * 1000
                    : RETRY_BASE_MS * attempt;
                log('WARN', `⚠️  UL attempt ${attempt} failed for "${fileName}": ${err.message}. Retry in ${delay}ms`);
                await sleep(delay);
                continue;
            }
            log('ERROR', `❌ UL failed: ${fileName} – ${err.message}`, err.stack);
            throw err;
        }
    }
}

// ─── Core: single MEGA file ───────────────────────────────────────────────────
async function processSingleFile(ctx, fileNode, statusMsg) {
    const chatId     = ctx.chat.id;
    const chatType   = ctx.chat.type;
    const userId     = ctx.from ? ctx.from.id : chatId;
    const tempDir    = path.join(os.tmpdir(), 'mega-bot', userId.toString());
    const tempPath   = path.join(tempDir, fileNode.name);
    const MAX_TG_SIZE = 2000 * 1024 * 1024;

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const editStatus = (text) =>
        safeEditMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id, text);

    const updater = createProgressUpdater(editStatus);

    if (fileNode.size > MAX_TG_SIZE) {
        await editStatus(`❌ *File Too Large*\n\n*Name:* \`${fileNode.name}\`\n*Size:* ${formatBytes(fileNode.size)}\n\n⚠️ Telegram limit is 2 GB.`);
        return;
    }

    // ── Download ──────────────────────────────────────────────────────────────
    try {
        await downloadOneFile(fileNode, tempPath, (p) => {
            const pct  = (p * 100).toFixed(1);
            const done = formatBytes(p * fileNode.size);
            const tot  = formatBytes(fileNode.size);
            updater(
                `⬇️ *Downloading from MEGA*\n` +
                `*Name:* \`${fileNode.name}\`\n` +
                `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                `[${makeProgressBar(p)}]`
            );
        });
    } catch (dlErr) {
        await editStatus(`❌ *Download Failed*\n\n*File:* \`${fileNode.name}\`\n*Error:* ${dlErr.message}`);
        cleanupFile(tempPath);
        return;
    }

    await editStatus(
        `✅ *Downloaded*\n\n*Name:* \`${fileNode.name}\`\n` +
        `*Size:* ${formatBytes(fileNode.size)}\n\n📤 Uploading to Telegram…`
    );

    // ── Upload ────────────────────────────────────────────────────────────────
    try {
        await sendTelegramFile(ctx, tempPath, fileNode.name, fileNode.size, (p) => {
            const pct  = (p * 100).toFixed(1);
            const done = formatBytes(p * fileNode.size);
            const tot  = formatBytes(fileNode.size);
            updater(
                `📤 *Uploading to Telegram*\n` +
                `*Name:* \`${fileNode.name}\`\n` +
                `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                `[${makeProgressBar(p)}]`
            );
        });

        await safeDeleteMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id);
        if (chatType !== 'private') await safeReply(ctx, '✅ *File sent successfully!*');

    } catch (ulErr) {
        await editStatus(`❌ *Upload Failed*\n\n*File:* \`${fileNode.name}\`\n*Error:* ${ulErr.message}`);
    } finally {
        cleanupFile(tempPath);
    }
}

// ─── Core: MEGA folder – stream one file at a time ───────────────────────────
async function processFolderStreaming(ctx, folderNode, megaUrl, statusMsg) {
    const chatId  = ctx.chat.id;
    const userId  = ctx.from ? ctx.from.id : chatId;
    const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
    const MAX_TG  = 2000 * 1024 * 1024;
    const MAX_DISK_BYTES = 200 * 1024 * 1024; // 200 MB safety threshold for progress messages

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const editStatus = (text) =>
        safeEditMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id, text);

    // ── 1. Enumerate file list (metadata only – no download) ──────────────────
    await editStatus('📂 *Loading folder contents…*\n\nReading file list from MEGA…');

    let allFiles;
    try {
        allFiles = await collectFolderFiles(folderNode);
    } catch (err) {
        await editStatus(`❌ *Cannot Read Folder*\n\n*Error:* ${err.message}`);
        return;
    }

    if (allFiles.length === 0) {
        await editStatus('❌ *Folder is empty.*');
        return;
    }

    const totalFiles = allFiles.length;
    const totalSize  = allFiles.reduce((s, f) => s + (f.size || 0), 0);
    const folderName = folderNode.name || 'folder';

    log('INFO', `📁 Folder "${folderName}": ${totalFiles} files, ${formatBytes(totalSize)}`);

    // ── 2. Load session (resume after restart) ────────────────────────────────
    let session = loadSession(megaUrl);
    if (!session) {
        session = {
            url:        megaUrl,
            folderName,
            chatId,
            totalFiles,
            totalSize,
            completed:  [],   // array of successfully uploaded file names
        };
        saveSession(megaUrl, session);
    }

    const completedSet = new Set(session.completed);
    const pendingFiles = allFiles.filter(f => !completedSet.has(f.name));
    const alreadyDone  = totalFiles - pendingFiles.length;

    if (alreadyDone > 0) {
        log('INFO', `🔁 Resuming: ${alreadyDone} already done, ${pendingFiles.length} remaining`);
    }

    // ── 3. Announce start ─────────────────────────────────────────────────────
    await safeDeleteMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id);
    statusMsg = null;

    await safeReply(ctx,
        `📁 *Folder: ${folderName}*\n\n` +
        `📊 *Total files:* ${totalFiles}\n` +
        `💾 *Total size:* ${formatBytes(totalSize)}\n` +
        (alreadyDone > 0
            ? `🔁 *Resuming from file ${alreadyDone + 1}*\n\n`
            : '\n') +
        `📂 Processing files one by one…`
    );

    // Single persistent progress message updated throughout the whole folder.
    let progressMsg = await safeReply(ctx,
        `📤 *Folder Upload Starting…*\n\n` +
        `✅ Sent: ${alreadyDone}/${totalFiles}\n❌ Failed: 0`
    );

    const editProgress = (text) =>
        safeEditMessage(ctx.telegram, chatId, progressMsg && progressMsg.message_id, text);

    let sentCount  = alreadyDone;
    let failedCount = 0;
    const progressUpdater = createProgressUpdater(editProgress);

    // ── 4. Process files one by one ───────────────────────────────────────────
    for (let i = 0; i < pendingFiles.length; i++) {
        const fileNode   = pendingFiles[i];
        const globalIdx  = sentCount + failedCount + i + 1; // position in the full list
        const tempPath   = path.join(tempDir, fileNode.name.replace(/[/\\]/g, '_'));

        log('INFO', `── File ${globalIdx}/${totalFiles}: ${fileNode.name} (${formatBytes(fileNode.size)})`);

        // Skip files too large for Telegram
        if (fileNode.size > MAX_TG) {
            log('WARN', `⏭  Skip (>2 GB): ${fileNode.name}`);
            failedCount++;
            await editProgress(
                `📁 *${folderName}*\n\n` +
                `✅ Sent: ${sentCount}/${totalFiles}  ❌ Failed: ${failedCount}\n\n` +
                `⏭ Skipped \\(>2 GB\\): \`${fileNode.name}\``
            );
            continue;
        }

        // ── 4a. Download this one file ────────────────────────────────────────
        let dlOk = false;
        try {
            await downloadOneFile(fileNode, tempPath, (p) => {
                const pct  = (p * 100).toFixed(1);
                const done = formatBytes(p * (fileNode.size || 0));
                const tot  = formatBytes(fileNode.size || 0);
                progressUpdater(
                    `📁 *${folderName}*\n` +
                    `📊 File ${globalIdx}/${totalFiles}\n\n` +
                    `⬇️ *Downloading:* \`${fileNode.name}\`\n` +
                    `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                    `[${makeProgressBar(p)}]\n\n` +
                    `✅ Sent: ${sentCount}  ❌ Failed: ${failedCount}`
                );
            });
            dlOk = true;
            log('INFO', `✅ Download OK: ${fileNode.name}`);
        } catch (dlErr) {
            log('ERROR', `❌ Download failed: ${fileNode.name} – ${dlErr.message}`, dlErr.stack);
            failedCount++;
            await editProgress(
                `📁 *${folderName}*\n\n` +
                `✅ Sent: ${sentCount}/${totalFiles}  ❌ Failed: ${failedCount}\n\n` +
                `❌ DL error on \`${fileNode.name}\`:\n${dlErr.message}`
            );
            cleanupFile(tempPath);
            continue; // move on – never abort the whole folder
        }

        // ── 4b. Upload immediately ────────────────────────────────────────────
        try {
            await sendTelegramFile(ctx, tempPath, fileNode.name, fileNode.size, (p) => {
                const pct  = (p * 100).toFixed(1);
                const done = formatBytes(p * (fileNode.size || 0));
                const tot  = formatBytes(fileNode.size || 0);
                progressUpdater(
                    `📁 *${folderName}*\n` +
                    `📊 File ${globalIdx}/${totalFiles}\n\n` +
                    `📤 *Uploading:* \`${fileNode.name}\`\n` +
                    `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                    `[${makeProgressBar(p)}]\n\n` +
                    `✅ Sent: ${sentCount}  ❌ Failed: ${failedCount}`
                );
            });
            sentCount++;
            log('INFO', `✅ Upload OK [${sentCount}/${totalFiles}]: ${fileNode.name}`);

            // Mark as completed in session – survive a restart.
            session.completed.push(fileNode.name);
            saveSession(megaUrl, session);

            // Brief pause between files to ease Telegram rate limits.
            await sleep(1500);

        } catch (ulErr) {
            log('ERROR', `❌ Upload failed: ${fileNode.name} – ${ulErr.message}`, ulErr.stack);
            failedCount++;
            await editProgress(
                `📁 *${folderName}*\n\n` +
                `✅ Sent: ${sentCount}/${totalFiles}  ❌ Failed: ${failedCount}\n\n` +
                `❌ UL error on \`${fileNode.name}\`:\n${ulErr.message}`
            );
            // Continue – never abort the whole folder.

        } finally {
            // ── 4c. Delete the temp file immediately ──────────────────────────
            cleanupFile(tempPath);
        }
    }

    // ── 5. Final cleanup ──────────────────────────────────────────────────────
    await safeDeleteMessage(ctx.telegram, chatId, progressMsg && progressMsg.message_id);
    cleanupFolder(tempDir);
    clearSession(megaUrl);

    let summary = `✅ *Folder Transfer Complete!*\n\n`;
    summary    += `📁 *Folder:* \`${folderName}\`\n`;
    summary    += `📊 *Total files:* ${totalFiles}\n`;
    summary    += `✅ *Sent:* ${sentCount}\n`;
    if (failedCount > 0) summary += `❌ *Failed/Skipped:* ${failedCount}\n`;
    summary    += `💾 *Total size:* ${formatBytes(totalSize)}`;

    await safeReply(ctx, summary);
    log('INFO', `📊 Folder done | sent=${sentCount} failed=${failedCount} total=${totalFiles}`);
}

// ─── Core handler ─────────────────────────────────────────────────────────────
async function processMegaLink(ctx, megaLink) {
    const userId   = ctx.from ? ctx.from.id : ctx.chat.id;
    const chatId   = ctx.chat.id;
    const chatType = ctx.chat.type;

    log('INFO', `📩 Processing | chat=${chatId} (${chatType}) user=${userId}`);
    log('INFO', `🔗 URL: ${megaLink}`);

    let statusMsg = null;

    try {
        statusMsg = await safeReply(ctx, '🔍 *Processing MEGA Link*\n\nConnecting to MEGA…');

        // ── Load MEGA metadata (no data transferred yet) ──────────────────────
        let item;
        try {
            item = await loadMegaItem(megaLink);
        } catch (err) {
            const msg =
                `❌ *Cannot Access Link*\n\n` +
                `*Error:* ${err.message}\n\n` +
                `*Please check:*\n` +
                `1. Link is correct and not expired\n` +
                `2. The #key is included at the end\n` +
                `3. The file/folder is publicly shared`;
            await safeEditMessage(ctx.telegram, chatId, statusMsg && statusMsg.message_id, msg);
            return;
        }

        log('INFO', `✅ Loaded: "${item.name}" (${item.directory ? 'folder' : formatBytes(item.size)})`);

        if (item.directory) {
            // ── FOLDER: stream one file at a time ─────────────────────────────
            await processFolderStreaming(ctx, item, megaLink, statusMsg);
            statusMsg = null; // processFolderStreaming owns and deletes it

        } else {
            // ── SINGLE FILE ───────────────────────────────────────────────────
            await safeEditMessage(
                ctx.telegram, chatId, statusMsg && statusMsg.message_id,
                `✅ *File Found*\n\n*Name:* \`${item.name}\`\n*Size:* ${formatBytes(item.size)}\n\n⬇️ Downloading…`
            );
            await processSingleFile(ctx, item, statusMsg);
            statusMsg = null;
        }

    } catch (err) {
        log('ERROR', `❌ processMegaLink: ${err.message}`, err.stack);
        const msg =
            `❌ *Unexpected Error*\n\n*Error:* ${err.message}\n\n` +
            `Please try again. If the problem persists, check the link.`;
        if (statusMsg) {
            await safeEditMessage(ctx.telegram, chatId, statusMsg.message_id, msg);
        } else {
            await safeReply(ctx, msg);
        }
    }
}

// ─── Bot commands ─────────────────────────────────────────────────────────────
bot.start((ctx) => {
    const chatType = ctx.chat.type;
    const chatName = chatType === 'private' ? 'here' : `in this ${chatType}`;
    ctx.reply(
        `🤖 *MEGA Downloader Bot*\n\n` +
        `*I can download MEGA files and folders ${chatName}!*\n\n` +
        `Just send me any MEGA link and I'll download it.\n\n` +
        `*Features:*\n` +
        `• Works in private chats, groups, and channels\n` +
        `• Downloads files and entire folders\n` +
        `• Folder files sent one by one – no disk overload\n` +
        `• Auto-resumes if interrupted\n` +
        `• Shows download and upload progress separately\n\n` +
        `*Supported Formats:*\n` +
        `• \`https://mega.nz/file/ID#KEY\`\n` +
        `• \`https://mega.nz/folder/ID#KEY\`\n\n` +
        `Send me a MEGA link to get started!`,
        { parse_mode: 'Markdown' }
    ).catch(err => log('WARN', `start reply: ${err.message}`));
});

bot.help((ctx) => {
    const chatType = ctx.chat.type;
    if (chatType === 'private') {
        ctx.reply(
            `📖 *Help – Private Chat*\n\n` +
            `Just send me any MEGA link and I'll handle it!\n\n` +
            `*Valid link formats:*\n` +
            `✅ \`https://mega.nz/file/ABC123#XYZ456\`\n` +
            `✅ \`https://mega.nz/folder/DEF789#UVW012\`\n\n` +
            `*Folder behaviour:*\n` +
            `Files are sent one by one. I download a file, send it, delete it,\n` +
            `then move to the next. Disk usage stays under 200 MB at all times.\n\n` +
            `*Limits:*\n` +
            `• Individual file must be under 2 GB (Telegram limit)\n` +
            `• Link must include the #key`,
            { parse_mode: 'Markdown' }
        ).catch(err => log('WARN', `help reply: ${err.message}`));
    } else {
        ctx.reply(
            `📖 *Help – ${chatType === 'group' ? 'Group' : 'Channel'}*\n\n` +
            `I can download MEGA files here!\n\n` +
            `*Requirements:*\n` +
            `1. Add me as admin\n` +
            `2. Enable read + send messages + send media\n\n` +
            `*Link formats:*\n` +
            `• \`https://mega.nz/file/ID#KEY\`\n` +
            `• \`https://mega.nz/folder/ID#KEY\``,
            { parse_mode: 'Markdown' }
        ).catch(err => log('WARN', `help reply: ${err.message}`));
    }
});

bot.on('message', async (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return;

    const megaLink = cleanMegaLink(text);
    if (!megaLink) {
        if (ctx.chat.type !== 'private') {
            const uname = ctx.botInfo && ctx.botInfo.username;
            if (uname && text.includes(`@${uname}`)) {
                await safeReply(ctx,
                    `🤖 Hi! Send me a MEGA link to download files.\n\n` +
                    `Example: \`https://mega.nz/file/ABC123#XYZ456\``
                );
            }
        }
        return;
    }

    log('INFO', `🔍 MEGA link detected | ${ctx.chat.type} ${ctx.chat.id}`);

    if (ctx.chat.type !== 'private') {
        try {
            const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);

            if (ctx.chat.type === 'channel') {
                if (member.status !== 'administrator') {
                    log('WARN', `Not admin in channel ${ctx.chat.id}`);
                    if (ctx.from) {
                        ctx.telegram.sendMessage(
                            ctx.from.id,
                            `❌ I'm not an admin in that channel. Please make me admin with read/post permissions.`
                        ).catch(() => {});
                    }
                    return;
                }
                if (!member.can_post_messages) { log('WARN', `Cannot post in channel ${ctx.chat.id}`); return; }
            }

            if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                if (member.status === 'restricted' && !member.can_send_messages) {
                    log('WARN', `Restricted in group ${ctx.chat.id}`); return;
                }
                if (!['administrator', 'member', 'restricted'].includes(member.status)) {
                    log('WARN', `Bad status in group ${ctx.chat.id}: ${member.status}`); return;
                }
            }
        } catch (err) {
            log('ERROR', `Permission check failed in ${ctx.chat.type} ${ctx.chat.id}: ${err.message}`);
            return;
        }
    }

    await processMegaLink(ctx, megaLink);
});

bot.on('document', (ctx) => {
    if (ctx.chat.type === 'private') {
        ctx.reply(
            '📎 Send me a MEGA link to download files!\n\nExample:\n`https://mega.nz/file/ABC123#XYZ456`',
            { parse_mode: 'Markdown' }
        ).catch(err => log('WARN', `document reply: ${err.message}`));
    }
});

bot.catch((err, ctx) => {
    log('ERROR', `Bot middleware error: ${err.message}`, err.stack);
    try {
        if (ctx && ctx.chat && ctx.chat.type === 'private') {
            ctx.reply('❌ An internal error occurred. Please try again.').catch(() => {});
        }
    } catch (e) { log('ERROR', `Failed to send error reply: ${e.message}`); }
});

// ─── Bot launch with auto-retry ───────────────────────────────────────────────
const LAUNCH_RETRY_DELAY = 5000;

async function launchWithRetry() {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            log('INFO', `🚀 Launching bot (attempt ${attempt})…`);
            const info = await bot.telegram.getMe();
            botUsername = info.username;
            log('INFO', `🤖 @${botUsername} – https://t.me/${botUsername}`);
            await bot.launch();
            log('INFO', '✅ Bot running!');
            log('INFO', `📁 Temp dir: ${os.tmpdir()}`);
            log('INFO', `📂 Sessions: ${SESSION_DIR}`);
            break;
        } catch (err) {
            log('ERROR', `❌ Launch failed (attempt ${attempt}): ${err.message}`, err.stack);
            log('INFO', `⏳ Retrying in ${LAUNCH_RETRY_DELAY / 1000}s…`);
            await sleep(LAUNCH_RETRY_DELAY);
        }
    }
}

launchWithRetry();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.once('SIGINT',  () => { log('INFO', '🛑 SIGINT'); bot.stop('SIGINT');  healthServer.close(); });
process.once('SIGTERM', () => { log('INFO', '🛑 SIGTERM'); bot.stop('SIGTERM'); healthServer.close(); });
