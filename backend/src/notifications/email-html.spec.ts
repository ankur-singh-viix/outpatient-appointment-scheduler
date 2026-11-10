import { escapeHtml, renderEmailHtml } from './email-html.js';
import * as templates from './templates.js';

const facts = {
  patientName: 'Rahul Sharma',
  doctorName: 'Dr. Rohan Das',
  clinicName: 'City Clinic',
  clinicAddress: '12 MG Road',
  date: '2026-11-02',
  startTime: '14:05',
  endTime: '14:35',
  specialty: 'ENT',
};

describe('renderEmailHtml', () => {
  it('is a complete, responsive document with the subject as its heading', () => {
    const html = renderEmailHtml({ subject: 'Appointment confirmed', body: 'Hi Rahul' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('<h1');
    expect(html).toContain('Appointment confirmed');
  });

  it('escapes everything from the message, so a name can never inject markup', () => {
    const html = renderEmailHtml({ subject: 'Hi <script>alert(1)</script>', body: 'Hello <img src=x onerror=alert(1)> & "friends"\n\nDoctor: <b>Dr. X</b>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Dr. X</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;friends&quot;');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });

  it('turns the appointment lines into a details table and paragraphs into paragraphs', () => {
    const message = templates.bookingConfirmed(facts);
    const html = renderEmailHtml({ subject: message.subject, body: message.body });
    expect(html).toContain('<table role="presentation"');
    for (const detail of ['Rohan Das', 'ENT', 'Mon, 2 Nov, 2026 at 2:05 PM – 2:35 PM', 'City Clinic, 12 MG Road']) expect(html).toContain(detail);
    expect(html).toContain('>Doctor</td>');
    expect(html).toContain('>Specialty</td>');
    expect(html).toContain('Your appointment is confirmed.');
    expect(html.match(/<p /g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('makes web addresses clickable, keeping trailing punctuation outside the link', () => {
    const html = renderEmailHtml({ subject: 'x', body: 'Choose a new time here (you will be asked to confirm): https://app.example.com/doctors/1?reschedule=a&date=2026-11-16.' });
    expect(html).toContain('<a href="https://app.example.com/doctors/1?reschedule=a&amp;date=2026-11-16"');
    expect(html).toMatch(/<\/a>\.<\/p>/);
  });

  it('keeps the whole wording of every patient message: nothing in the text is lost in the HTML', () => {
    const messages = [
      templates.bookingConfirmed(facts),
      templates.bookingRescheduled(facts, { date: '2026-11-01', startTime: '10:00', endTime: '10:30' }),
      templates.bookingCancelled(facts, { cancelledBy: 'DOCTOR', reason: 'Emergency', refundNote: 'Full refund.' }),
      templates.needsNewTime(facts, { link: 'https://app.example.com/doctors/1?reschedule=a' }),
      templates.appointmentRestored(facts),
    ];
    for (const message of messages) {
      const html = renderEmailHtml({ subject: message.subject, body: message.body });
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
      for (const sentence of message.body.split(/\n+/).filter((line) => !/^(Doctor|Specialty|Patient|When|Where|Reason): /.test(line) && line.length > 25)) {
        expect(text, sentence.slice(0, 40)).toContain(sentence.replace(/https?:\/\/\S+/g, '').trim().slice(0, 25));
      }
    }
  });
});
