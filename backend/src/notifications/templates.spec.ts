import * as templates from './templates.js';

const facts = {
  patientName: 'Rahul Sharma',
  doctorName: 'Dr. Rohan Das',
  clinicName: 'City Clinic',
  clinicAddress: '12 MG Road',
  date: '2026-11-02',
  startTime: '14:05',
};

describe('message templates', () => {
  it('describes the appointment in plain words, in the clinic time', () => {
    const message = templates.bookingConfirmed(facts);
    expect(message.subject).toContain('Dr. Rohan Das');
    expect(message.subject).toContain('2:05 PM');
    expect(message.body).toContain('Mon, 2 Nov, 2026');
    expect(message.body).toContain('City Clinic, 12 MG Road');
    expect(message.kind).toBe('booking-confirmed');
  });

  it('shows midnight and noon correctly on a 12-hour clock', () => {
    expect(templates.bookingConfirmed({ ...facts, startTime: '00:30' }).subject).toContain('12:30 AM');
    expect(templates.bookingConfirmed({ ...facts, startTime: '12:00' }).subject).toContain('12:00 PM');
  });

  it('says who cancelled, why, and what happens to the money', () => {
    const byDoctor = templates.bookingCancelled(facts, { cancelledBy: 'DOCTOR', reason: 'Emergency', refundNote: 'Full refund.' });
    expect(byDoctor.body).toContain('cancelled by the doctor');
    expect(byDoctor.body).toContain('Emergency');
    expect(byDoctor.body).toContain('Full refund.');
    expect(templates.bookingCancelled(facts, { cancelledBy: 'SYSTEM', reason: 'x' }).body).toContain('payment was not completed in time');
    expect(templates.bookingCancelled(facts, { cancelledBy: 'PATIENT', reason: 'x' }).body).toContain('cancelled by you');
  });

  it('words a refund by what has actually happened, never claiming it is done early', () => {
    const base = { amountPaise: 32500, reason: 'Policy' };
    expect(templates.refundUpdate(facts, { ...base, status: 'PENDING' }).body).toContain('has been started');
    expect(templates.refundUpdate(facts, { ...base, status: 'PENDING' }).body).not.toMatch(/has been processed/);
    expect(templates.refundUpdate(facts, { ...base, status: 'PROCESSED' }).body).toContain('has been processed');
    expect(templates.refundUpdate(facts, { ...base, status: 'FAILED' }).body).toContain('could not be completed');
    expect(templates.refundUpdate(facts, { ...base, status: 'PROCESSED' }).subject).toContain('Rs. 325.00');
  });

  it('words a reminder in days or hours', () => {
    expect(templates.reminder(facts, 24).body).toContain('in about 1 day');
    expect(templates.reminder(facts, 48).body).toContain('in about 2 days');
    expect(templates.reminder(facts, 2).body).toContain('in about 2 hours');
    expect(templates.reminder(facts, 1).body).toContain('in about 1 hour.');
    expect(templates.reminder(facts, 2).kind).toBe('reminder');
  });

  it('never includes anything but the patient-facing facts', () => {
    for (const message of [templates.bookingConfirmed(facts), templates.paymentReceived(facts, { amountPaise: 65000, receipt: 'pay_1' })]) {
      expect(message.body).not.toMatch(/secret|password|token/i);
    }
    expect(templates.paymentReceived(facts, { amountPaise: 65000, receipt: 'pay_1' }).body).toContain('Receipt: pay_1');
  });
});

describe('doctor messages, payment failure and text messages', () => {
  const range = { ...facts, startTime: '11:15', endTime: '11:45' };

  it('shows the full time range when the end time is known', () => {
    expect(templates.bookingConfirmed(range).subject).toContain('11:15 AM – 11:45 AM');
  });

  it('writes the doctor a different message from the patient, naming the patient and nothing sensitive', () => {
    const toDoctor = templates.bookingConfirmed(range, 'doctor');
    expect(toDoctor.subject).toBe('New booking: Rahul Sharma, Mon, 2 Nov, 2026 at 11:15 AM – 11:45 AM');
    expect(toDoctor.body).toContain('Hello Dr. Rohan Das');
    expect(toDoctor.body).toContain('Patient: Rahul Sharma');
    expect(toDoctor.subject).not.toBe(templates.bookingConfirmed(range).subject);
    expect(toDoctor.body).not.toMatch(/@|\+\d|password|token/i); // no email address, phone number or credential
  });

  it('tells the doctor who cancelled, and the patient who cancelled', () => {
    const input = { reason: 'Plans changed', refundNote: undefined };
    expect(templates.bookingCancelled(range, { cancelledBy: 'PATIENT', ...input }, 'doctor').body).toContain('Rahul Sharma cancelled');
    expect(templates.bookingCancelled(range, { cancelledBy: 'DOCTOR', ...input }, 'doctor').body).toContain('You cancelled');
    expect(templates.bookingCancelled(range, { cancelledBy: 'SYSTEM', ...input }, 'doctor').body).toContain('CareSlot released');
    expect(templates.bookingCancelled(range, { cancelledBy: 'DOCTOR', ...input }).body).toContain('cancelled by the doctor');
  });

  it('gives the doctor the old and the new time when an appointment is moved', () => {
    const toDoctor = templates.bookingRescheduled(range, { date: '2026-11-01', startTime: '10:00', endTime: '10:30' }, 'doctor');
    expect(toDoctor.body).toContain('from Sun, 1 Nov, 2026 at 10:00 AM – 10:30 AM');
    expect(toDoctor.body).toContain('Rahul Sharma');
    expect(toDoctor.subject).toMatch(/^Booking rescheduled:/);
  });

  it('tells the patient a payment failed, that the slot is held, and where to retry', () => {
    const message = templates.paymentFailed(range, { reason: 'Card declined' });
    expect(message.kind).toBe('payment-failed');
    expect(message.subject).toMatch(/^Payment failed:/);
    expect(message.body).toContain('did not go through');
    expect(message.body).toContain('Card declined');
    expect(message.body).toContain('My Appointments');
    expect(templates.paymentFailed(range, {}).body).not.toContain('Reason given');
  });

  it('gives every patient event a short text version of at most 160 characters', () => {
    const long = { ...range, doctorName: 'Dr. Bartholomew Montgomery-Featherstonehaugh', clinicName: 'A Very Long Clinic Name Indeed' };
    const all = [
      templates.bookingConfirmed(long),
      templates.bookingRescheduled(long, { date: '2026-11-01', startTime: '10:00', endTime: '10:30' }),
      templates.bookingCancelled(long, { cancelledBy: 'DOCTOR', reason: 'r' }),
      templates.paymentReceived(long, { amountPaise: 65000, receipt: 'pay_AbCdEfGhIjKl' }),
      templates.paymentFailed(long, { reason: 'x'.repeat(300) }),
      templates.refundUpdate(long, { amountPaise: 32500, status: 'PENDING', reason: 'r' }),
      templates.refundUpdate(long, { amountPaise: 32500, status: 'PROCESSED', reason: 'r' }),
      templates.refundUpdate(long, { amountPaise: 32500, status: 'FAILED', reason: 'r' }),
      templates.reminder(long, 24),
    ];
    for (const message of all) {
      expect(message.sms.length).toBeGreaterThan(10);
      expect(message.sms.length).toBeLessThanOrEqual(160);
      expect(message.sms.startsWith('CareSlot')).toBe(true);
      expect(message.sms).not.toContain('\n');
    }
  });

  it('writes no text version for the doctor, who is only emailed', () => {
    expect(templates.bookingConfirmed(range, 'doctor').sms).toBe('');
    expect(templates.bookingCancelled(range, { cancelledBy: 'PATIENT', reason: 'r' }, 'doctor').sms).toBe('');
  });

  it('describes each refund state in its own words in the text too', () => {
    const sms = (status: 'PENDING' | 'PROCESSED' | 'FAILED') => templates.refundUpdate(range, { amountPaise: 32500, status, reason: 'r' }).sms;
    expect(sms('PENDING')).toContain('has been started');
    expect(sms('PROCESSED')).toContain('has been processed');
    expect(sms('FAILED')).toContain('could not be completed');
  });
});
