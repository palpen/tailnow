const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest();
const SESSION_MS = 60 * 60 * 1000;

class AdminAuth {
  constructor(directory, { now = Date.now } = {}) {
    this.file = path.join(directory, 'admin-token');
    this.now = now;
    try { fs.writeFileSync(this.file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 128 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Admin credential must be private and owned by the service account');
      value = fs.readFileSync(fd, 'utf8').trim();
    } finally { fs.closeSync(fd); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid admin credential');
    this.keyHash = digest(value);
    this.sessions = new Map();
    this.attempts = [];
  }
  token(req) {
    const count = req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'authorization').length;
    const match = count === 1 && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    return match ? match[1] : '';
  }
  isKey(token) { return Boolean(token) && timingSafeEqual(digest(token), this.keyHash); }
  authorized(req) {
    const token = this.token(req);
    if (this.isKey(token)) return true;
    const key = digest(token).toString('hex'), expiry = this.sessions.get(key);
    if (expiry && expiry > this.now()) return true;
    this.sessions.delete(key);
    return false;
  }
  login(req) {
    this.attempts = this.attempts.filter(time => time > this.now() - 60000);
    if (this.attempts.length >= 20) return { status: 429 };
    if (!this.isKey(this.token(req))) { this.attempts.push(this.now()); return { status: 401 }; }
    for (const [key, expiry] of this.sessions) if (expiry <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + SESSION_MS;
    this.sessions.set(digest(token).toString('hex'), expiresAt);
    return { status: 200, token, expiresAt };
  }
  logout(req) { this.sessions.delete(digest(this.token(req)).toString('hex')); }
}

module.exports = { AdminAuth, SESSION_MS };
