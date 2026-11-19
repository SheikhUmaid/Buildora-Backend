import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from '../utils/http.js';

const uploadDir = fileURLToPath(config.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const AUDIO_TYPES = new Set([
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/wav',
  'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/3gpp', 'audio/amr',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const AUDIO_EXT = new Set(['.m4a', '.aac', '.mp3', '.wav', '.webm', '.ogg', '.3gp', '.amr', '.mp4']);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

// Mobile pickers sometimes send application/octet-stream, so fall back to the extension.
function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const isAudioField = file.fieldname === 'voiceNote';
  const ok = isAudioField
    ? AUDIO_TYPES.has(file.mimetype) || AUDIO_EXT.has(ext)
    : IMAGE_TYPES.has(file.mimetype) || IMAGE_EXT.has(ext);
  if (!ok) return cb(badRequest(`Unsupported file type for ${file.fieldname}: ${file.originalname}`));
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSizeMb * 1024 * 1024, files: config.maxPhotosPerUpdate + 1 },
});

/** Accepts up to N photos in field "photos" plus one optional "voiceNote". */
export const mediaUpload = upload.fields([
  { name: 'photos', maxCount: config.maxPhotosPerUpdate },
  { name: 'voiceNote', maxCount: 1 },
]);

export const fileUrl = (file) => `/uploads/${file.filename}`;

export function filesFrom(req, field) {
  return (req.files?.[field] ?? []).map(fileUrl);
}

/** Best-effort removal of files we own (only paths under /uploads/). */
export function deleteUploads(urls = []) {
  for (const url of urls) {
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) continue;
    const name = path.basename(url);
    fs.promises.unlink(path.join(uploadDir, name)).catch(() => {});
  }
}
