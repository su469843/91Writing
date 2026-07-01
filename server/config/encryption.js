const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function deriveKey() {
  const secretKey = process.env.ENCRYPTION_KEY;
  const fallback = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  const source = secretKey || fallback;
  return crypto.createHash('sha256').update(source).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const key = deriveKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return '';

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
