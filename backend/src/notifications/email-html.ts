// Turns the plain-text body every notification already has into a simple, responsive HTML email, at send time. The outbox keeps
// only the text (so nothing about stored messages changes, and the text version is always what is sent alongside), and the
// templates stay the single place the wording lives.
//
// Layout: one centred 600px column with inline styles and a table, which every major mail client renders; it shrinks on a phone.
// Everything from the message is escaped, so a patient or doctor name can never inject markup.

const BRAND = '#0f766e';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Lines like "Doctor: Dr. Rao" that describe the appointment; consecutive ones become a small table. */
const DETAIL = /^(Doctor|Specialty|Patient|When|Where|Reason): (.+)$/;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escapes text and turns web addresses into links (leaving a trailing full stop, comma or bracket outside the link). */
function linkify(text: string): string {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (match) => {
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    // The address was escaped above, so & is already &amp; and is correct inside an attribute.
    return `<a href="${url}" style="color:${BRAND};text-decoration:underline;word-break:break-all;">${url}</a>${trailing}`;
  });
}

function paragraph(lines: string[]): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#1f2933;">${lines.map(linkify).join('<br>')}</p>`;
}

function detailsTable(rows: [string, string][]): string {
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;font-size:14px;color:#52606d;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-size:15px;color:#1f2933;font-weight:600;">${linkify(value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;padding:12px 16px;background:#f0f7f6;border-radius:8px;border-left:4px solid ${BRAND};"><tbody>${cells}</tbody></table>`;
}

/** The body as HTML blocks: blank lines separate paragraphs, a run of "Label: value" lines becomes a details table. */
function blocks(body: string): string {
  const out: string[] = [];
  for (const chunk of body.replace(/\r\n/g, '\n').trim().split(/\n{2,}/)) {
    let text: string[] = [];
    let details: [string, string][] = [];
    const flushText = () => {
      if (text.length) out.push(paragraph(text));
      text = [];
    };
    const flushDetails = () => {
      if (details.length) out.push(detailsTable(details));
      details = [];
    };
    for (const line of chunk.split('\n')) {
      const detail = DETAIL.exec(line);
      if (detail) {
        flushText();
        details.push([detail[1], detail[2]]);
      } else {
        flushDetails();
        text.push(line);
      }
    }
    flushDetails();
    flushText();
  }
  return out.join('');
}

/** A complete HTML document for one notification email. */
export function renderEmailHtml(input: { subject: string; body: string }): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(input.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f6f8;font-family:${FONT};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6f8;"><tbody><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;"><tbody>` +
    `<tr><td style="background:${BRAND};padding:18px 24px;font-size:20px;font-weight:700;color:#ffffff;">CareSlot</td></tr>` +
    `<tr><td style="padding:28px 24px 8px;"><h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#102a43;">${escapeHtml(input.subject)}</h1>${blocks(input.body)}</td></tr>` +
    `<tr><td style="padding:16px 24px 24px;border-top:1px solid #e4e7eb;font-size:12px;line-height:1.5;color:#7b8794;">` +
    `You are receiving this message about an appointment booked on CareSlot. It does not contain any medical information. ` +
    `If you were not expecting it, you can ignore it.</td></tr>` +
    `</tbody></table></td></tr></tbody></table></body></html>`
  );
}
