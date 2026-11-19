import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isJpegSignature, isPdfSignature, isPngSignature, MEDICAL_REPORT_MAX_BYTES, validateReportFile } from './file-validation.js';

const pdf = Buffer.from('%PDF-1.4 sample');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('file-validation', () => {
  it('detects PDF, JPEG and PNG signatures', () => {
    expect(isPdfSignature(pdf)).toBe(true);
    expect(isJpegSignature(jpeg)).toBe(true);
    expect(isPngSignature(png)).toBe(true);
    expect(isPdfSignature(jpeg)).toBe(false);
  });

  it('accepts valid PDF, JPEG and PNG uploads', () => {
    expect(validateReportFile({ buffer: pdf, mimetype: 'application/pdf', originalname: 'labs.pdf' }).contentType).toBe('application/pdf');
    expect(validateReportFile({ buffer: jpeg, mimetype: 'image/jpeg', originalname: 'xray.jpg' }).contentType).toBe('image/jpeg');
    expect(validateReportFile({ buffer: png, mimetype: 'image/png', originalname: 'scan.png' }).contentType).toBe('image/png');
  });

  it('rejects MIME/content mismatches and unknown types', () => {
    expect(() => validateReportFile({ buffer: pdf, mimetype: 'image/png', originalname: 'labs.pdf' })).toThrow(BadRequestException);
    expect(() => validateReportFile({ buffer: Buffer.from('hello'), mimetype: 'text/plain', originalname: 'notes.txt' })).toThrow(BadRequestException);
  });

  it('rejects oversize files', () => {
    const big = Buffer.concat([pdf, Buffer.alloc(MEDICAL_REPORT_MAX_BYTES)]);
    expect(() => validateReportFile({ buffer: big, mimetype: 'application/pdf', originalname: 'big.pdf', size: big.length })).toThrow(
      /10 MB/i,
    );
  });
});
