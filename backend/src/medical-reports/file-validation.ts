import { BadRequestException } from '@nestjs/common';

/** Hard cap for medical report uploads (10 MiB). */
export const MEDICAL_REPORT_MAX_BYTES = 10 * 1024 * 1024;

export type AllowedReportContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface ValidatedReportFile {
  buffer: Buffer;
  contentType: AllowedReportContentType;
  originalFilename: string;
  byteSize: number;
}

/** True when the buffer starts with a PDF header. */
export function isPdfSignature(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF';
}

/** True when the buffer starts with a JPEG SOI marker. */
export function isJpegSignature(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** True when the buffer starts with a PNG signature. */
export function isPngSignature(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((byte, index) => buffer[index] === byte);
}

function detectContentType(buffer: Buffer): AllowedReportContentType | null {
  if (isPdfSignature(buffer)) return 'application/pdf';
  if (isJpegSignature(buffer)) return 'image/jpeg';
  if (isPngSignature(buffer)) return 'image/png';
  return null;
}

function extensionMatches(name: string, contentType: AllowedReportContentType): boolean {
  if (contentType === 'application/pdf') return /\.pdf$/i.test(name);
  if (contentType === 'image/jpeg') return /\.jpe?g$/i.test(name);
  return /\.png$/i.test(name);
}

/**
 * Validates size, magic bytes, and that filename/MIME agree with the detected type.
 * Declared MIME alone is never trusted.
 */
export function validateReportFile(input: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size?: number;
}): ValidatedReportFile {
  const byteSize = input.size ?? input.buffer.length;
  if (!input.buffer?.length || byteSize <= 0) {
    throw new BadRequestException('Choose a PDF, JPG or PNG file to upload.');
  }
  if (byteSize > MEDICAL_REPORT_MAX_BYTES) {
    throw new BadRequestException('File is too large. The maximum size is 10 MB.');
  }

  const contentType = detectContentType(input.buffer);
  if (!contentType) {
    throw new BadRequestException('Only PDF, JPG and PNG files are supported.');
  }

  const name = ((input.originalname ?? 'report').trim() || 'report').slice(0, 255).replace(/[/\\]/g, '_');
  const mime = (input.mimetype ?? '').toLowerCase().trim();

  if (mime && mime !== contentType) {
    throw new BadRequestException('File type does not match the file contents.');
  }
  if (!extensionMatches(name, contentType) && !mime) {
    throw new BadRequestException('File name extension must be .pdf, .jpg/.jpeg or .png.');
  }
  if (!extensionMatches(name, contentType) && mime === contentType) {
    // Allow MIME-correct uploads with a missing/odd extension by normalizing the name.
    const suffix = contentType === 'application/pdf' ? '.pdf' : contentType === 'image/png' ? '.png' : '.jpg';
    return {
      buffer: input.buffer,
      contentType,
      originalFilename: /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, suffix) : `${name}${suffix}`,
      byteSize,
    };
  }
  if (!extensionMatches(name, contentType)) {
    throw new BadRequestException('File name extension must match the file type (PDF, JPG or PNG).');
  }

  return { buffer: input.buffer, contentType, originalFilename: name, byteSize };
}
