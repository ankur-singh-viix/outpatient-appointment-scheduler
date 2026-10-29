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
