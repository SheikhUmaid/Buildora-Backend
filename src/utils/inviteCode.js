import crypto from 'node:crypto';

// No 0/O/1/I to avoid confusion when read aloud or typed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

export function generatePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
