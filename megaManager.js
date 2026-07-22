'use strict';

const mega = require('megajs');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
require('dotenv').config();

/**
 * MegaManager – handles authenticated MEGA storage operations.
 *
 * Changes vs original:
 * - initialize() catches its own errors so the constructor never throws an
 *   unhandled rejection that could kill the process.
 * - connectionPromise is stored cleanly so reject/resolve can't be called
 *   on a stale or undefined reference.
 * - downloadFileToPath wraps the stream start in try/catch so a sync throw
 *   doesn't escape as an unhandled rejection.
 */
class MegaManager {
    constructor() {
        this.storage          = null;
        this.uploadFolder     = process.env.MEGA_UPLOAD_FOLDER || 'tm';
        this.maxFileSize      = parseInt(process.env.MAX_FILE_SIZE) || 2147483648;
        this.maxFolderSize    = 1073741824;
        this.isConnected      = false;
        this._resolveConn     = null;
        this._rejectConn      = null;
        this.connectionPromise = new Promise((res, rej) => {
            this._resolveConn = res;
            this._rejectConn  = rej;
        });

        // Fire-and-forget – errors are caught internally.
        this._initialize().catch(err => {
            console.error('[MegaManager] Unhandled initialize error:', err.message);
        });
    }

    async _initialize() {
        try {
            console.log('[MegaManager] Initializing...');

            this.storage = new mega.Storage({
                email:     'session',
                password:  process.env.MEGA_SESSION,
                autologin: false,
            });

            this.storage.on('ready', () => {
                console.log('[MegaManager] ✅ Connected to MEGA');
                this.isConnected = true;
                if (this._resolveConn) { this._resolveConn(); this._resolveConn = null; }
            });

            this.storage.on('error', (err) => {
                console.error('[MegaManager] ❌ MEGA connection error:', err.message);
                this.isConnected = false;
                if (this._rejectConn) { this._rejectConn(err); this._rejectConn = null; }
            });

            // Timeout guard
            setTimeout(() => {
                if (!this.isConnected && this._rejectConn) {
                    this._rejectConn(new Error('MEGA connection timeout'));
                    this._rejectConn = null;
                }
            }, 15000);

        } catch (err) {
            console.error('[MegaManager] Initialize failed:', err.message);
            if (this._rejectConn) { this._rejectConn(err); this._rejectConn = null; }
        }
    }

    async ensureConnected() {
        if (this.isConnected) return;
        try {
            await this.connectionPromise;
        } catch (err) {
            throw new Error(`MEGA connection failed: ${err.message}`);
        }
    }

    async getAccountInfo() {
        try {
            await this.ensureConnected();
            const account   = this.storage.account || {};
            let fileCount   = 0;
            if (this.storage.root && this.storage.root.children) {
                fileCount = this.storage.root.children.length;
            }
            return {
                email:      account.email      || 'Session User',
                spaceUsed:  account.spaceUsed  || 0,
                spaceTotal: account.spaceTotal  || 2147483648,
                spaceFree:  (account.spaceTotal || 2147483648) - (account.spaceUsed || 0),
                files:      fileCount,
                connection: 'Active',
            };
        } catch (err) {
            console.error('[MegaManager] getAccountInfo error:', err.message);
            return { email: 'Not Connected', spaceUsed: 0, spaceTotal: 0, spaceFree: 0, files: 0, connection: 'Failed' };
        }
    }

    async downloadItem(megaUrl, userId) {
        await this.ensureConnected();

        const cleanUrl = megaUrl.trim().replace(/\s+/g, '').replace(/^.*(mega\.nz\/)/, 'https://mega.nz/');
        console.log(`[MegaManager] Downloading from: ${cleanUrl}`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Download timeout')), 300000);

            let file;
            try {
                file = mega.File.fromURL(cleanUrl, {}, this.storage);
            } catch (err) {
                clearTimeout(timeout);
                return reject(new Error(`Invalid link: ${err.message}`));
            }

            file.loadAttributes((err) => {
                if (err) {
                    clearTimeout(timeout);
                    return reject(new Error(`Failed to load: ${err.message}`));
                }
                console.log(`[MegaManager] Loaded: ${file.name} (${file.directory ? 'Folder' : 'File'})`);
                if (file.directory) {
                    this._handleFolderDownload(file, userId, timeout, resolve, reject);
                } else {
                    this._handleFileDownload(file, userId, timeout, resolve, reject);
                }
            });
        });
    }

    _handleFileDownload(file, userId, timeout, resolve, reject) {
        try {
            if (file.size > this.maxFileSize) {
                clearTimeout(timeout);
                return reject(new Error(`File too large: ${this.formatBytes(file.size)}`));
            }
            const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempPath    = path.join(tempDir, this.sanitizeFilename(file.name));
            const writeStream = fs.createWriteStream(tempPath);

            console.log(`[MegaManager] Downloading file: ${file.name}`);

            let stream;
            try {
                stream = file.download({});
            } catch (e) {
                clearTimeout(timeout);
                writeStream.destroy();
                return reject(new Error(`Download init failed: ${e.message}`));
            }

            stream.on('error', (err) => {
                clearTimeout(timeout);
                writeStream.destroy();
                this.cleanupFile(tempPath);
                reject(new Error(`Download failed: ${err.message}`));
            }).pipe(writeStream);

            writeStream.on('finish', () => {
                clearTimeout(timeout);
                resolve({ type: 'file', path: tempPath, name: file.name, size: file.size });
            });
            writeStream.on('error', (err) => {
                clearTimeout(timeout);
                this.cleanupFile(tempPath);
                reject(new Error(`Save failed: ${err.message}`));
            });
        } catch (err) {
            clearTimeout(timeout);
            reject(new Error(`File processing error: ${err.message}`));
        }
    }

    _handleFolderDownload(folder, userId, timeout, resolve, reject) {
        try {
            const allFiles  = this._getAllFilesFromFolder(folder);
            if (allFiles.length === 0) {
                clearTimeout(timeout);
                return reject(new Error('Folder is empty'));
            }
            const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
            if (totalSize > this.maxFolderSize) {
                clearTimeout(timeout);
                return reject(new Error(`Folder too large: ${this.formatBytes(totalSize)}`));
            }
            console.log(`[MegaManager] Folder: ${allFiles.length} files, ${this.formatBytes(totalSize)}`);

            const folderDir = path.join(os.tmpdir(), 'mega-bot', userId.toString(), this.sanitizeFilename(folder.name));
            if (!fs.existsSync(folderDir)) fs.mkdirSync(folderDir, { recursive: true });

            const downloadedFiles = [];
            const downloadNext    = async (index) => {
                if (index >= allFiles.length) {
                    clearTimeout(timeout);
                    if (downloadedFiles.length === 0) return reject(new Error('No files could be downloaded'));
                    return resolve({ type: 'folder', folderPath: folderDir, files: downloadedFiles, fileCount: downloadedFiles.length, totalSize, name: folder.name });
                }
                const fileInfo = allFiles[index];
                const filePath = path.join(folderDir, this.sanitizeFilename(fileInfo.name));
                try {
                    await this.downloadFileToPath(fileInfo.node, filePath);
                    downloadedFiles.push({ path: filePath, name: fileInfo.name, size: fileInfo.size });
                    console.log(`[MegaManager] Downloaded: ${fileInfo.name}`);
                } catch (err) {
                    console.error(`[MegaManager] Failed: ${fileInfo.name}: ${err.message}`);
                }
                await downloadNext(index + 1);
            };

            downloadNext(0).catch(err => { clearTimeout(timeout); reject(err); });

        } catch (err) {
            clearTimeout(timeout);
            reject(new Error(`Folder download error: ${err.message}`));
        }
    }

    _getAllFilesFromFolder(folder, files = []) {
        if (!folder.children) return files;
        for (const child of folder.children) {
            if (child.directory) this._getAllFilesFromFolder(child, files);
            else files.push({ node: child, name: child.name, size: child.size || 0 });
        }
        return files;
    }

    async downloadFileToPath(file, filePath) {
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(filePath);
            let stream;
            try {
                stream = file.download({});
            } catch (e) {
                writeStream.destroy();
                return reject(e);
            }
            stream.on('error', (err) => { writeStream.destroy(); reject(err); }).pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    async uploadFile(filePath, fileName, userId) {
        await this.ensureConnected();
        if (!fs.existsSync(filePath)) throw new Error('File not found');
        const stats = fs.statSync(filePath);
        if (stats.size > this.maxFileSize) throw new Error(`File too large: ${this.formatBytes(stats.size)}`);
        console.log(`[MegaManager] Uploading: ${fileName} (${this.formatBytes(stats.size)})`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Upload timeout')), 600000);
            try {
                let uploadFolder = this.storage.root.children.find(c => c && c.name === this.uploadFolder && c.directory);
                if (!uploadFolder) {
                    this.storage.mkdir(this.uploadFolder, (err, folder) => {
                        if (err) { clearTimeout(timeout); return reject(new Error(`Failed to create folder: ${err.message}`)); }
                        this._doUpload(folder, filePath, fileName, stats, timeout, resolve, reject);
                    });
                } else {
                    this._doUpload(uploadFolder, filePath, fileName, stats, timeout, resolve, reject);
                }
            } catch (err) {
                clearTimeout(timeout);
                reject(new Error(`Upload setup failed: ${err.message}`));
            }
        });
    }

    _doUpload(folder, filePath, fileName, stats, timeout, resolve, reject) {
        const readStream = fs.createReadStream(filePath);
        folder.upload({ name: this.sanitizeFilename(fileName) }, readStream, (err, file) => {
            clearTimeout(timeout);
            if (err) { readStream.destroy(); return reject(new Error(`Upload failed: ${err.message}`)); }
            console.log(`[MegaManager] Upload successful: ${file.name}`);
            let downloadLink = 'No direct link';
            try { if (file.downloadId) downloadLink = `https://mega.nz/file/${file.downloadId}`; } catch (_) {}
            resolve({ name: file.name, size: stats.size, link: downloadLink });
        });
        readStream.on('error', (err) => { clearTimeout(timeout); reject(new Error(`Read error: ${err.message}`)); });
    }

    async listFiles() {
        try {
            await this.ensureConnected();
            const uploadFolder = this.storage.root.children.find(c => c && c.name === this.uploadFolder && c.directory);
            if (!uploadFolder) return [];
            return (uploadFolder.children || [])
                .filter(c => c && !c.directory)
                .map(c => ({ name: c.name, size: c.size || 0, link: c.downloadId ? `https://mega.nz/file/${c.downloadId}` : null }));
        } catch (err) {
            console.error('[MegaManager] listFiles error:', err.message);
            return [];
        }
    }

    sanitizeFilename(filename) {
        return filename.replace(/[<>:"/\\|?*]/g, '_').trim().substring(0, 200);
    }

    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    cleanupFile(filePath) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
        catch (err) { console.error('[MegaManager] Cleanup file error:', err.message); }
    }

    cleanupFolder(folderPath) {
        try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); }
        catch (err) { console.error('[MegaManager] Cleanup folder error:', err.message); }
    }

    cleanupUserFiles(userId) {
        this.cleanupFolder(path.join(os.tmpdir(), 'mega-bot', userId.toString()));
    }
}

module.exports = new MegaManager();
