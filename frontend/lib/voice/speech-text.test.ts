import { describe, expect, it } from 'vitest';
import { chunkText, scriptOf, toSegments, toSpeakable } from './speech-text';

describe('toSpeakable: what is read aloud', () => {
  it('drops markdown symbols but keeps the words', () => {
    expect(toSpeakable('## Your appointments\n- **Dr. Rao** on *Mon 12 Nov* at 9:30 AM\n- `Dr. Mehta` on Tue')).toBe('Your appointments. Dr. Rao on Mon 12 Nov at 9:30 AM. Dr. Mehta on Tue');
    expect(toSpeakable('1. First slot\n2) Second slot')).toBe('First slot. Second slot');
    expect(toSpeakable('See [My Appointments](https://app.example.com/appointments) for details')).toBe('See My Appointments for details');
    expect(toSpeakable('| Time | Status |\n| 9:00 | Booked |')).toContain('Time');
    expect(toSpeakable('| Time | Status |')).not.toContain('|');
  });

  it('never reads JSON, code, ids, links or tool names', () => {
    const reply = 'Done. ```json\n{"ref":"x"}\n``` {"appointmentId":"5f1b2c9e-1234-4abc-9def-0123456789ab","state":"DONE"} id 5f1b2c9e-1234-4abc-9def-0123456789ab order_Qx12AbC pay_9Zz rfnd_77 via get_my_appointments see https://x.test/a?b=1 end';
    const spoken = toSpeakable(reply);
    expect(spoken).toBe('Done. id via see end');
    expect(spoken).not.toMatch(/[{}"`]|get_|order_|pay_|rfnd_|http|[0-9a-f]{8}-/);
  });

  it('says money as words, in the reply language', () => {
    expect(toSpeakable('The fee is Rs. 650 and the refund is Rs. 325.50.')).toBe('The fee is 650 rupees and the refund is 325.50 rupees.');
    expect(toSpeakable('फीस Rs. 650 है')).toBe('फीस 650 रुपये है');
  });

  it('removes emoji and stray underscores/asterisks, and ends a line like a sentence', () => {
    expect(toSpeakable('Booked ✅ for tomorrow 🎉\nSee you there')).toBe('Booked for tomorrow. See you there');
    expect(toSpeakable('_note_ and snake_case_word')).toContain('snake_case_word');
    expect(toSpeakable('***bold***')).toBe('bold');
  });

  it('keeps times, dates and doctor names exactly as written', () => {
    const reply = 'Dr. Anita Rao at CityCare Clinic, 12 MG Road: Thu, 19 Nov 2026, 9:30 AM – 10:00 AM.';
    expect(toSpeakable(reply)).toBe(reply);
  });
});

describe('scriptOf', () => {
  it('tells Hindi from English by the share of Devanagari letters, not by one word', () => {
    expect(scriptOf('आपके अपॉइंटमेंट ये हैं')).toBe('hi');
    expect(scriptOf('Your appointment with Dr. Rao is tomorrow')).toBe('en');
    expect(scriptOf('Mera appointment kal hai')).toBe('en'); // Hinglish in Roman letters
    expect(scriptOf('Your appointment है')).toBe('en'); // one stray word
    expect(scriptOf('12:30 !!!')).toBe('en');
  });
});

describe('chunkText: pieces that can be spoken whole', () => {
  it('keeps a short reply as one piece and splits at sentences', () => {
    expect(chunkText('One short sentence.')).toEqual(['One short sentence.']);
    const pieces = chunkText('First sentence is here. Second sentence follows! Third one? Yes.', 30);
    expect(pieces.every((piece) => piece.length <= 30)).toBe(true);
    expect(pieces.join(' ')).toBe('First sentence is here. Second sentence follows! Third one? Yes.');
  });

  it('never cuts a word, however long the sentence', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const pieces = chunkText(words.join(' ') + '.', 60);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 60)).toBe(true);
    expect(pieces.join(' ').replace(/\.$/, '').split(' ')).toEqual(words); // every word intact, in order, none lost
  });

  it('does not split a sentence at "Dr.", "St.", "Rs." or an initial', () => {
    expect(chunkText('Your appointment is with Dr. Rao at CityCare, St. John Rd. today. See you then.', 70)).toEqual(['Your appointment is with Dr. Rao at CityCare, St. John Rd. today.', 'See you then.']);
    expect(chunkText('Dr. A. K. Rao will see you.')).toEqual(['Dr. A. K. Rao will see you.']);
    expect(chunkText('The fee is Rs. 650. Thank you.')).toEqual(['The fee is Rs. 650. Thank you.']);
  });

  it('splits Hindi on the danda and drops pieces with nothing to say', () => {
    expect(chunkText('आपका अपॉइंटमेंट कल है। कृपया समय पर आएं।', 25)).toEqual(['आपका अपॉइंटमेंट कल है।', 'कृपया समय पर आएं।']);
    expect(chunkText('. ! ...')).toEqual([]);
  });
});

describe('toSegments: which voice reads which piece', () => {
  it('reads Devanagari pieces in Hindi and Latin pieces in the chosen locale', () => {
    const segments = toSegments('आपका अपॉइंटमेंट कल है। Dr. Rao will see you at 9:30 AM.', 'en-IN');
    expect(segments.map((segment) => segment.lang)).toEqual(['hi-IN', 'en-IN']);
    expect(toSegments('Mera appointment kal hai.', 'en-IN')[0].lang).toBe('en-IN');
    // a Hindi reply with an English name and amount in it stays ONE piece, in the Hindi voice
    expect(toSegments('आपके पास कोई अपॉइंटमेंट नहीं है। **Dr. Demo Scheduler** से मिलने के लिए Rs. 650 लगेंगे।', 'en-IN')).toEqual([{ text: 'आपके पास कोई अपॉइंटमेंट नहीं है। Dr. Demo Scheduler से मिलने के लिए 650 रुपये लगेंगे।', lang: 'hi-IN' }]);
  });
  it('has nothing to say for a reply with only symbols or data', () => {
    expect(toSegments('```json\n{"a":1}\n```', 'en-IN')).toEqual([]);
  });
});
