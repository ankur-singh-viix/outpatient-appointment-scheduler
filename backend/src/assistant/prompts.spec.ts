import { systemPrompt } from './prompts.js';

const context = { name: 'Dr. Test', today: '2026-11-13', time: '10:00', timeZone: 'Asia/Kolkata' };
const SINGLE_DATE_RULE = 'When a schedule change is requested for a single date, ask whether it is just that day or every week, before preparing a card.';

describe('systemPrompt: single-date schedule changes', () => {
  it('tells the doctor assistant to ask whether a one-date change is just that day or every week, before preparing a card', () => {
    expect(systemPrompt('DOCTOR', context)).toContain(SINGLE_DATE_RULE);
  });

  it('is in the doctor prompt only', () => {
    expect(systemPrompt('PATIENT', context)).not.toContain(SINGLE_DATE_RULE);
  });

  it('comes before the instructions that prepare a card, and is there with voice and language hints too', () => {
    const plain = systemPrompt('DOCTOR', context);
    expect(plain.indexOf(SINGLE_DATE_RULE)).toBeLessThan(plain.indexOf('To shorten or extend a session'));
    expect(systemPrompt('DOCTOR', context, { voice: true, language: 'hinglish' })).toContain(SINGLE_DATE_RULE);
  });
});
