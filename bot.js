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

// ─── Active task registry & stop signals ─────────────────────────────────────
// activeTasks  : userId → { megaUrl, chatId, type ('single'|'folder') }
// stopSignals  : userId → 'pause' | 'cancel'
// Both are in-memory. Stop/cancel persists via the session file on disk.
const activeTasks = new Map();
const stopSignals = new Map();
// folderBrowsers : userId → metadata-only folder selection session
const folderBrowsers = new Map();

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

const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);
function isSupportedVideoFile(fileName) {
    return SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(fileName || '').toLowerCase());
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

// Scan session directory for a paused session belonging to a specific user.
function findPausedSession(userId) {
    try {
        if (!fs.existsSync(SESSION_DIR)) return null;
        const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
                if (String(data.userId) === String(userId) && data.status === 'paused') {
                    return data;
                }
            } catch (_) {}
        }
    } catch (err) { log('WARN', `findPausedSession: ${err.message}`); }
    return null;
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

// ─── MEGA: recursively scan folder metadata for the interactive browser ─────
// The scan never downloads file data. Each file/folder gets a stable path key
// so duplicate names in different branches remain independently selectable.
async function scanFolderTree(folder) {
    const folders = [];
    const files = [];

    async function ensureChildren(node) {
        if (node.children && Array.isArray(node.children)) return node.children;
        await new Promise((resolve, reject) => {
            const fn = node.loadChildren || node.getChildren;
            if (typeof fn !== 'function') return reject(new Error('Cannot enumerate folder children'));
            fn.call(node, (err, children) => {
                if (err) return reject(err);
                node.children = children || [];
                resolve();
            });
        });
        return node.children;
    }

    async function walk(node, folderPath, folderId) {
        const descriptor = {
            id: folders.length,
            node,
            path: folderPath,
            name: node.name || 'folder',
            depth: folderPath.length,
            fileCount: 0,
            videoSize: 0,
            parentId: folderId,
        };
        folders.push(descriptor);

        const children = await ensureChildren(node);
        for (const child of children) {
            if (child.directory) {
                await walk(child, folderPath.concat(child.name || 'folder'), descriptor.id);
                continue;
            }

            const filePath = folderPath.concat(child.name || 'file');
            const entry = {
                key: filePath.join('/'),
                node: child,
                name: child.name || 'file',
                size: child.size || 0,
                folderPath,
                folderId: descriptor.id,
            };
            files.push(entry);
            descriptor.fileCount++;
            if (isSupportedVideoFile(entry.name)) descriptor.videoSize += entry.size;
        }
    }

    await walk(folder, [], null);
    return { folders, files };
}

function folderPathLabel(folderPath, rootName) {
    return [rootName].concat(folderPath || []).join(' / ');
}

function formatGigabytes(bytes) {
    return `${((bytes || 0) / (1024 ** 3)).toFixed(2)} GB`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const total = Math.ceil(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function formatRate(bytesPerSecond) {
    return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—';
}

function folderSelectionKey(folder) {
    return (folder.path || []).join('/');
}

function getSelectedVideoFiles(browser) {
    const selectedIds = browser.selectedFolderIds;
    if (selectedIds.size === 0) return [];
    const folderById = new Map(browser.folders.map(folder => [folder.id, folder]));

    return browser.files.filter(file => {
        if (!isSupportedVideoFile(file.name)) return false;
        let folderId = file.folderId;
        while (folderId !== null && folderId !== undefined) {
            if (selectedIds.has(folderId)) return true;
            const folder = folderById.get(folderId);
            folderId = folder ? folder.parentId : null;
        }
        return false;
    });
}

function getBrowserTotals(browser) {
    const selectedFiles = getSelectedVideoFiles(browser);
    return {
        selectedFolders: browser.folders.filter(folder =>
            browser.selectedFolderIds.has(folder.id)
        ).length,
        selectedFiles,
        videoCount: selectedFiles.length,
        totalSize: selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0),
    };
}

function browserText(browser) {
    const totals = getBrowserTotals(browser);
    const pageCount = Math.max(1, Math.ceil(browser.folders.length / browser.pageSize));
    const page = Math.min(browser.page, pageCount - 1);
    const start = page * browser.pageSize;
    const visibleFolders = browser.folders.slice(start, start + browser.pageSize);
    const folderLines = visibleFolders.length
        ? visibleFolders.map(folder => {
            const icon = browser.selectedFolderIds.has(folder.id) ? '✅' : '📁';
            const indent = '  '.repeat(Math.min(folder.depth, 8));
            return `${icon} ${indent}${folder.name}`;
        }).join('\n')
        : 'No folders found.';

    return (
        `📂 MEGA Folder Browser\n\n` +
        `Select one or more folders. Subfolders are included automatically.\n\n` +
        `${folderLines}\n\n` +
        `Page ${page + 1}/${pageCount}\n\n` +
        `Selected folders: ${totals.selectedFolders}\n` +
        `Total videos found: ${totals.videoCount}\n` +
        `Total size: ${formatGigabytes(totals.totalSize)}`
    );
}

function browserKeyboard(browser) {
    const pageCount = Math.max(1, Math.ceil(browser.folders.length / browser.pageSize));
    const page = Math.min(browser.page, pageCount - 1);
    browser.page = page;
    const start = page * browser.pageSize;
    const rows = browser.folders.slice(start, start + browser.pageSize).map(folder => {
        const icon = browser.selectedFolderIds.has(folder.id) ? '✅' : '📁';
        const label = `${icon} ${'  '.repeat(Math.min(folder.depth, 4))}${folder.name}`;
        return [{ text: label.slice(0, 60), callback_data: `fb_toggle:${browser.userId}:${folder.id}` }];
    });

    if (pageCount > 1) {
        rows.push([
            { text: page > 0 ? '◀ Previous' : ' ', callback_data: page > 0 ? `fb_page:${browser.userId}:${page - 1}` : `fb_noop:${browser.userId}` },
            { text: `${page + 1}/${pageCount}`, callback_data: `fb_noop:${browser.userId}` },
            { text: page < pageCount - 1 ? 'Next ▶' : ' ', callback_data: page < pageCount - 1 ? `fb_page:${browser.userId}:${page + 1}` : `fb_noop:${browser.userId}` },
        ]);
    }

    rows.push([
        { text: '▶ Start Upload', callback_data: `fb_start:${browser.userId}` },
        { text: '🔄 Refresh', callback_data: `fb_refresh:${browser.userId}` },
    ]);
    rows.push([{ text: '❌ Cancel', callback_data: `fb_cancel:${browser.userId}` }]);
    return { inline_keyboard: rows };
}

async function editFolderBrowser(ctx, browser) {
    try {
        await ctx.telegram.editMessageText(
            browser.chatId,
            browser.messageId,
            null,
            browserText(browser),
            { reply_markup: browserKeyboard(browser) }
        );
    } catch (err) {
        if (!isIgnorableEditError(err)) log('WARN', `Cannot render folder browser: ${err.message}`);
    }
}

function makeFolderBrowser(userId, chatId, megaUrl, folderNode, tree, messageId) {
    return {
        userId: String(userId),
        chatId,
        megaUrl,
        folderNode,
        rootName: folderNode.name || 'folder',
        folders: tree.folders,
        files: tree.files,
        selectedFolderIds: new Set(),
        page: 0,
        pageSize: 35,
        messageId,
    };
}

function fileIdentity(file) {
    return file.key || file.name;
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
async function processFolderStreaming(ctx, folderNode, megaUrl, statusMsg, selectedFiles = null) {
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

    let allFiles = selectedFiles;
    if (!allFiles) {
        try {
            allFiles = await collectFolderFiles(folderNode);
        } catch (err) {
            await editStatus(`❌ *Cannot Read Folder*\n\n*Error:* ${err.message}`);
            return;
        }
    }
    // Folder transfers only ever include the formats supported by the browser.
    allFiles = allFiles.filter(file => isSupportedVideoFile((file.node || file).name));

    if (allFiles.length === 0) {
        await editStatus('❌ *No supported videos were selected.*');
        return;
    }

    const totalFiles = allFiles.length;
    const totalSize  = allFiles.reduce((s, f) => s + ((f.node || f).size || 0), 0);
    const folderName = folderNode.name || 'folder';

    log('INFO', `📁 Folder "${folderName}": ${totalFiles} files, ${formatBytes(totalSize)}`);

    // ── 2. Load session (resume after restart) ────────────────────────────────
    let session = loadSession(megaUrl);
    if (!session) {
        session = {
            url:        megaUrl,
            folderName,
            chatId,
            userId,
            totalFiles,
            totalSize,
            selectedFileKeys: allFiles.map(fileIdentity),
            completed:  [],   // array of successfully uploaded file names
            status:     'active',
        };
        saveSession(megaUrl, session);
    } else {
        // Resuming: mark active and ensure userId is recorded.
        session.status = 'active';
        session.userId = userId;
        saveSession(megaUrl, session);
    }

    const completedSet = new Set(session.completed);
    const pendingFiles = allFiles.filter(f => !completedSet.has(fileIdentity(f)));
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

        // ── Check stop/cancel signal before starting the next file ────────────
        if (stopSignals.has(userId)) {
            const signal = stopSignals.get(userId);
            stopSignals.delete(userId);
            const remaining = pendingFiles.length - i;

            if (signal === 'cancel') {
                clearSession(megaUrl);
                cleanupFolder(tempDir);
                await editProgress(
                    `❌ *Download Cancelled*\n\n` +
                    `📁 *Folder:* \`${folderName}\`\n` +
                    `✅ Sent: ${sentCount}/${totalFiles}  ❌ Failed: ${failedCount}`
                );
                await safeReply(ctx,
                    `🗑 *Download cancelled.* All temporary files have been deleted.`,
                    { parse_mode: 'Markdown' }
                );
                log('INFO', `🗑 Folder cancelled by user. sent=${sentCount} remaining=${remaining}`);
                return;
            }

            // signal === 'pause'
            session.status = 'paused';
            saveSession(megaUrl, session);
            await editProgress(
                `⏸ *Download Paused*\n\n` +
                `📁 *Folder:* \`${folderName}\`\n` +
                `✅ Sent: ${sentCount}/${totalFiles}  ❌ Failed: ${failedCount}`
            );
            await safeReply(ctx,
                `⏸ *Download Paused Successfully*\n\n` +
                `✅ Completed Files: ${sentCount}/${totalFiles}\n` +
                `📋 Remaining Files: ${remaining}\n\n` +
                `Progress has been saved\\.`,
                {
                    parse_mode: 'MarkdownV2',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '▶ Resume', callback_data: `resume:${userId}` }],
                            [
                                { text: '❌ Cancel', callback_data: `cancel:${userId}` },
                                { text: '🏠 Main Menu', callback_data: `main_menu:${userId}` },
                            ],
                        ],
                    },
                }
            );
            log('INFO', `⏸ Folder paused by user. sent=${sentCount} remaining=${remaining}`);
            return;
        }

        const selectedFile = pendingFiles[i];
        const fileNode   = selectedFile.node || selectedFile;
        const currentFolder = selectedFile.folderPath
            ? [folderName].concat(selectedFile.folderPath).join(' / ')
            : folderName;
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
        const downloadStartedAt = Date.now();
        try {
            await downloadOneFile(fileNode, tempPath, (p) => {
                const pct  = (p * 100).toFixed(1);
                const done = formatBytes(p * (fileNode.size || 0));
                const tot  = formatBytes(fileNode.size || 0);
                const elapsed = Math.max((Date.now() - downloadStartedAt) / 1000, 0.001);
                const downloadSpeed = (p * (fileNode.size || 0)) / elapsed;
                const remainingBytes = Math.max(0, (fileNode.size || 0) * (1 - p)) +
                    pendingFiles.slice(i + 1)
                        .reduce((sum, file) => sum + ((file.node || file).size || 0), 0);
                const eta = downloadSpeed > 0 ? remainingBytes / downloadSpeed : 0;
                progressUpdater(
                    `📁 *Current Folder:* ${currentFolder}\n` +
                    `🎬 *Current File:* \`${fileNode.name}\`\n` +
                    `📊 File ${globalIdx}/${totalFiles}\n\n` +
                    `⬇️ *Downloading:* \`${fileNode.name}\`\n` +
                    `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                    `[${makeProgressBar(p)}]\n` +
                    `Download speed: ${formatRate(downloadSpeed)}\n\n` +
                    `ETA: ${formatDuration(eta)}\n\n` +
                    `✅ Completed: ${sentCount}/${totalFiles}  📋 Remaining: ${totalFiles - sentCount}`
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
            const uploadStartedAt = Date.now();
            await sendTelegramFile(ctx, tempPath, fileNode.name, fileNode.size, (p) => {
                const pct  = (p * 100).toFixed(1);
                const done = formatBytes(p * (fileNode.size || 0));
                const tot  = formatBytes(fileNode.size || 0);
                const elapsed = Math.max((Date.now() - uploadStartedAt) / 1000, 0.001);
                const uploadSpeed = (p * (fileNode.size || 0)) / elapsed;
                const remainingBytes = pendingFiles.slice(i + 1)
                    .reduce((sum, file) => sum + ((file.node || file).size || 0), 0);
                const eta = uploadSpeed > 0 ? remainingBytes / uploadSpeed : 0;
                progressUpdater(
                    `📁 *Current Folder:* ${currentFolder}\n` +
                    `🎬 *Current File:* \`${fileNode.name}\`\n` +
                    `📊 File ${globalIdx}/${totalFiles}\n\n` +
                    `📤 *Uploading:* \`${fileNode.name}\`\n` +
                    `*Progress:* ${pct}%  •  ${done} / ${tot}\n` +
                    `[${makeProgressBar(p)}]\n` +
                    `Upload speed: ${formatRate(uploadSpeed)}\n` +
                    `ETA: ${formatDuration(eta)}\n\n` +
                    `✅ Completed: ${sentCount}/${totalFiles}  📋 Remaining: ${totalFiles - sentCount}`
                );
            });
            sentCount++;
            log('INFO', `✅ Upload OK [${sentCount}/${totalFiles}]: ${fileNode.name}`);

            // Mark as completed in session – survive a restart.
            session.completed.push(fileIdentity(selectedFile));
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
async function processMegaLink(ctx, megaLink, resumeExisting = false) {
    const userId   = String(ctx.from ? ctx.from.id : ctx.chat.id);
    const chatId   = ctx.chat.id;
    const chatType = ctx.chat.type;

    // Prevent starting a second task while one is already running.
    if (activeTasks.has(userId) || folderBrowsers.has(userId)) {
        await safeReply(ctx,
            `⚠️ *You already have an active download\\.*\n\nUse /stop to pause it first\\.`,
            { parse_mode: 'MarkdownV2' }
        );
        return;
    }

    log('INFO', `📩 Processing | chat=${chatId} (${chatType}) user=${userId}`);
    log('INFO', `🔗 URL: ${megaLink}`);

    // Register task immediately so a second link cannot replace the browser.
    activeTasks.set(userId, { megaUrl: megaLink, chatId, type: 'browser' });

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
            // ── FOLDER: scan metadata and wait for folder selection ───────────
            await safeEditMessage(
                ctx.telegram,
                chatId,
                statusMsg && statusMsg.message_id,
                '📂 *Scanning folder structure…*\n\nReading folders and video metadata from MEGA…'
            );
            let tree;
            try {
                tree = await scanFolderTree(item);
            } catch (err) {
                await safeEditMessage(
                    ctx.telegram,
                    chatId,
                    statusMsg && statusMsg.message_id,
                    `❌ *Cannot Read Folder*\n\n*Error:* ${err.message}`
                );
                return;
            }

            const browser = makeFolderBrowser(userId, chatId, megaLink, item, tree, statusMsg.message_id);
            const pausedSession = loadSession(megaLink);
            if (resumeExisting && pausedSession && pausedSession.status === 'paused' && Array.isArray(pausedSession.selectedFileKeys)) {
                // /resume uses the same metadata scan, then bypasses the picker.
                const selectedKeys = new Set(pausedSession.selectedFileKeys);
                const selectedFiles = tree.files.filter(file => selectedKeys.has(fileIdentity(file)));
                if (selectedFiles.length > 0) {
                    activeTasks.set(userId, { megaUrl: megaLink, chatId, type: 'folder' });
                    await processFolderStreaming(ctx, item, megaLink, statusMsg, selectedFiles);
                    statusMsg = null;
                    return;
                }
            }

            folderBrowsers.set(userId, browser);
            await editFolderBrowser(ctx, browser);
            // Keep the user task occupied while the picker is open.
            statusMsg = null;

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
    } finally {
        if (!folderBrowsers.has(userId)) activeTasks.delete(userId);
        stopSignals.delete(userId);
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
        `*Commands:*\n` +
        `• /stop – Pause the current folder download\n` +
        `• /resume – Continue a paused download\n` +
        `• /cancel – Cancel and delete all temp files\n\n` +
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

// ─── /stop ────────────────────────────────────────────────────────────────────
bot.command('stop', async (ctx) => {
    const userId = String(ctx.from ? ctx.from.id : ctx.chat.id);

    if (folderBrowsers.has(userId)) {
        await safeReply(ctx, '📂 Folder selection is open. Choose Start Upload or Cancel first.');
        return;
    }

    if (!activeTasks.has(userId)) {
        await safeReply(ctx, '❌ No active download found\\. Start one by sending a MEGA link\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    const task = activeTasks.get(userId);
    if (task.type === 'single') {
        await safeReply(ctx,
            '⚠️ *A single\\-file download is running\\.* It will complete shortly and cannot be paused\\.',
            { parse_mode: 'MarkdownV2' }
        );
        return;
    }

    // Signal the folder loop to pause after the current file finishes.
    stopSignals.set(userId, 'pause');
    await safeReply(ctx,
        '⏸ *Stopping…*\n\nThe current file will finish uploading first, then the download will pause\\.',
        { parse_mode: 'MarkdownV2' }
    );
    log('INFO', `⏸ /stop requested by user ${userId}`);
});

// ─── /resume ──────────────────────────────────────────────────────────────────
bot.command('resume', async (ctx) => {
    const userId = String(ctx.from ? ctx.from.id : ctx.chat.id);

    if (activeTasks.has(userId)) {
        await safeReply(ctx, '⚠️ A download is already in progress\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    const session = findPausedSession(userId);
    if (!session) {
        await safeReply(ctx, '❌ No paused download found\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    const done      = session.completed ? session.completed.length : 0;
    const total     = session.totalFiles || '?';
    const remaining = (typeof total === 'number') ? total - done : '?';

    await safeReply(ctx,
        `▶️ *Resuming download…*\n\n` +
        `📁 *Folder:* \`${session.folderName}\`\n` +
        `✅ *Already done:* ${done}/${total}\n` +
        `📋 *Remaining:* ${remaining}`,
        { parse_mode: 'Markdown' }
    );

    log('INFO', `▶️ /resume requested by user ${userId} – folder "${session.folderName}"`);

    // Re-dispatch through the normal pipeline; session state is already on disk.
    await processMegaLink(ctx, session.url, true);
});

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.command('cancel', async (ctx) => {
    const userId = String(ctx.from ? ctx.from.id : ctx.chat.id);

    if (folderBrowsers.has(userId)) {
        const browser = folderBrowsers.get(userId);
        folderBrowsers.delete(userId);
        activeTasks.delete(userId);
        await safeReply(ctx, '❌ Folder selection cancelled.');
        try {
            await ctx.telegram.editMessageText(
                browser.chatId,
                browser.messageId,
                null,
                '❌ Folder selection cancelled.'
            );
        } catch (_) {}
        return;
    }

    const hasActive = activeTasks.has(userId);
    const session   = !hasActive ? findPausedSession(userId) : null;

    if (!hasActive && !session) {
        await safeReply(ctx, '❌ Nothing to cancel\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    if (hasActive) {
        // Signal the running loop to cancel after the current file.
        stopSignals.set(userId, 'cancel');
        await safeReply(ctx,
            '🗑 *Cancelling…*\n\nThe current file will finish, then all temp files will be deleted\\.',
            { parse_mode: 'MarkdownV2' }
        );
        log('INFO', `🗑 /cancel requested (active) by user ${userId}`);
    } else {
        // Paused session – clean up immediately.
        clearSession(session.url);
        const tempDir = path.join(os.tmpdir(), 'mega-bot', userId);
        cleanupFolder(tempDir);
        await safeReply(ctx,
            `🗑 *Download cancelled\\.*\n\n📁 *Folder:* \`${session.folderName}\`\n\nAll temporary files have been deleted\\.`,
            { parse_mode: 'MarkdownV2' }
        );
        log('INFO', `🗑 /cancel requested (paused) by user ${userId} – folder "${session.folderName}"`);
    }
});

// ─── Inline button callbacks ───────────────────────────────────────────────────
// Folder browser buttons use fb_* callbacks. Pause controls use the legacy
// resume/cancel/main_menu callbacks below.

function getBrowserForCallback(ctx, targetUserId) {
    const callerId = String(ctx.from ? ctx.from.id : ctx.chat.id);
    if (callerId !== String(targetUserId)) return null;
    return folderBrowsers.get(callerId) || null;
}

bot.action(/^fb_noop:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
});

bot.action(/^fb_toggle:(.+):(\d+)$/, async (ctx) => {
    const browser = getBrowserForCallback(ctx, ctx.match[1]);
    if (!browser) {
        await ctx.answerCbQuery('This folder browser is no longer active.').catch(() => {});
        return;
    }

    const folder = browser.folders[Number(ctx.match[2])];
    if (!folder) {
        await ctx.answerCbQuery('Folder not found. Please refresh.').catch(() => {});
        return;
    }

    if (browser.selectedFolderIds.has(folder.id)) browser.selectedFolderIds.delete(folder.id);
    else browser.selectedFolderIds.add(folder.id);

    await ctx.answerCbQuery().catch(() => {});
    await editFolderBrowser(ctx, browser);
});

bot.action(/^fb_page:(.+):(\d+)$/, async (ctx) => {
    const browser = getBrowserForCallback(ctx, ctx.match[1]);
    if (!browser) {
        await ctx.answerCbQuery('This folder browser is no longer active.').catch(() => {});
        return;
    }

    browser.page = Number(ctx.match[2]);
    await ctx.answerCbQuery().catch(() => {});
    await editFolderBrowser(ctx, browser);
});

bot.action(/^fb_refresh:(.+)$/, async (ctx) => {
    const browser = getBrowserForCallback(ctx, ctx.match[1]);
    if (!browser) {
        await ctx.answerCbQuery('This folder browser is no longer active.').catch(() => {});
        return;
    }

    await ctx.answerCbQuery('Refreshing folder list…').catch(() => {});
    try {
        const selectedPaths = new Set(
            [...browser.selectedFolderIds]
                .map(id => browser.folders.find(folder => folder.id === id))
                .filter(Boolean)
                .map(folderSelectionKey)
        );
        const tree = await scanFolderTree(browser.folderNode);
        browser.folders = tree.folders;
        browser.files = tree.files;
        browser.selectedFolderIds = new Set(
            tree.folders
                .filter(folder => selectedPaths.has(folderSelectionKey(folder)))
                .map(folder => folder.id)
        );
        await editFolderBrowser(ctx, browser);
    } catch (err) {
        log('WARN', `Folder refresh failed: ${err.message}`);
        await ctx.answerCbQuery(`Refresh failed: ${err.message}`.slice(0, 190)).catch(() => {});
    }
});

bot.action(/^fb_cancel:(.+)$/, async (ctx) => {
    const callerId = String(ctx.from ? ctx.from.id : ctx.chat.id);
    const browser = getBrowserForCallback(ctx, ctx.match[1]);
    if (!browser) {
        await ctx.answerCbQuery('This folder browser is no longer active.').catch(() => {});
        return;
    }

    folderBrowsers.delete(callerId);
    activeTasks.delete(callerId);
    await ctx.answerCbQuery('Selection cancelled.').catch(() => {});
    try {
        await ctx.editMessageText('❌ Folder selection cancelled.');
    } catch (err) {
        if (!isIgnorableEditError(err)) log('WARN', `Cannot cancel folder browser: ${err.message}`);
    }
});

bot.action(/^fb_start:(.+)$/, async (ctx) => {
    const callerId = String(ctx.from ? ctx.from.id : ctx.chat.id);
    const browser = getBrowserForCallback(ctx, ctx.match[1]);
    if (!browser) {
        await ctx.answerCbQuery('This folder browser is no longer active.').catch(() => {});
        return;
    }

    const selectedFiles = getSelectedVideoFiles(browser);
    if (selectedFiles.length === 0) {
        await ctx.answerCbQuery('Select at least one folder containing a supported video.').catch(() => {});
        return;
    }

    const totals = getBrowserTotals(browser);
    folderBrowsers.delete(callerId);
    activeTasks.set(callerId, {
        megaUrl: browser.megaUrl,
        chatId: browser.chatId,
        type: 'folder',
    });
    await ctx.answerCbQuery('Starting upload…').catch(() => {});
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}

    log('INFO', `▶️ Folder selection started | user=${callerId} folders=${totals.selectedFolders} videos=${selectedFiles.length}`);
    try {
        await processFolderStreaming(
            ctx,
            browser.folderNode,
            browser.megaUrl,
            { message_id: browser.messageId },
            selectedFiles
        );
    } finally {
        activeTasks.delete(callerId);
    }
});

bot.action(/^resume:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const targetUserId = ctx.match[1];
    const callerId     = String(ctx.from ? ctx.from.id : ctx.chat.id);

    if (callerId !== targetUserId) {
        await ctx.answerCbQuery('⛔ Only the person who started this download can resume it.').catch(() => {});
        return;
    }

    if (activeTasks.has(callerId)) {
        await ctx.answerCbQuery('A download is already running.').catch(() => {});
        return;
    }

    const session = findPausedSession(callerId);
    if (!session) {
        try { await ctx.editMessageText('❌ No paused download found.'); } catch (_) {}
        return;
    }

    try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (_) {}

    log('INFO', `▶️ Resume button pressed by user ${callerId}`);
    await processMegaLink(ctx, session.url, true);
});

bot.action(/^cancel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const targetUserId = ctx.match[1];
    const callerId     = String(ctx.from ? ctx.from.id : ctx.chat.id);

    if (callerId !== targetUserId) {
        await ctx.answerCbQuery('⛔ Only the person who started this download can cancel it.').catch(() => {});
        return;
    }

    const hasActive = activeTasks.has(callerId);
    const session   = !hasActive ? findPausedSession(callerId) : null;

    if (!hasActive && !session) {
        try { await ctx.editMessageText('❌ Nothing to cancel.'); } catch (_) {}
        return;
    }

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}

    if (hasActive) {
        stopSignals.set(callerId, 'cancel');
        try { await ctx.editMessageText('🗑 Cancelling… The current file will finish, then temp files will be deleted.'); } catch (_) {}
        log('INFO', `🗑 Cancel button pressed (active) by user ${callerId}`);
    } else {
        clearSession(session.url);
        const tempDir = path.join(os.tmpdir(), 'mega-bot', callerId);
        cleanupFolder(tempDir);
        try {
            await ctx.editMessageText(
                `🗑 Download cancelled.\n\n📁 Folder: ${session.folderName}\n\nAll temporary files have been deleted.`
            );
        } catch (_) {}
        log('INFO', `🗑 Cancel button pressed (paused) by user ${callerId}`);
    }
});

bot.action(/^main_menu:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
    ctx.reply(
        `🤖 *MEGA Downloader Bot*\n\n` +
        `Send me any MEGA link to download it!\n\n` +
        `*Commands:*\n` +
        `• /stop – Pause the current folder download\n` +
        `• /resume – Continue a paused download\n` +
        `• /cancel – Cancel and delete all temp files\n\n` +
        `*Supported formats:*\n` +
        `• \`https://mega.nz/file/ID#KEY\`\n` +
        `• \`https://mega.nz/folder/ID#KEY\``,
        { parse_mode: 'Markdown' }
    ).catch(() => {});
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
