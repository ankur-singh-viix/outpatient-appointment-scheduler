// Checks what Payments & Receipts really prints, using Chromium's own A4 PDF output.
//
// The frontend has no test runner, so this is a manual check. It needs Playwright (`npm i --no-save playwright`, then
// `npx playwright install chromium`), a running app and API, and a DISPOSABLE database: it seeds three paid appointments for the
// patient below (one with a partial refund, long clinic names), after wiping that database's appointments, payments and refunds.
//
//   BASE_URL=http://localhost:3001 TEST_PSQL="docker exec -i outpatient-postgres psql -U postgres -d outpatient_test -At" \
//     node scripts/verify-receipt-print.mjs
//
// Asserts: one receipt is one A4 page, three are three pages (one each), nothing is wider than the page or clipped, and the
// navigation, sidebar, buttons and dashboard are gone from the printed page. Exits non-zero on any failure.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const PSQL = process.env.TEST_PSQL;
const EMAIL = process.env.PATIENT_EMAIL ?? 'patient1@test.local';
const PASSWORD = process.env.PATIENT_PASSWORD ?? 'Test@1234';
const OUT = process.env.OUT_DIR ?? './print-out/';
if (!PSQL) throw new Error('Set TEST_PSQL to a psql command for the disposable test database.');
mkdirSync(OUT, { recursive: true });

const psql = (sql) => execSync(`${PSQL} -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf8' });
const pdfPages = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures += 1;
};

psql(`DELETE FROM notifications; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;
UPDATE clinics SET name = 'The Very Long Named Multi-Speciality Outpatient Clinic and Diagnostic Centre', address = 'Block C, Sector 21, Industrial Estate Road, Near Central Railway Station, Mumbai, Maharashtra 400001';`);
const seed = (n, date, start, end, amount, refundPaise) =>
  psql(`
WITH p AS (SELECT p.id AS patient_id, u.id AS user_id FROM patients p JOIN users u ON u.id = p.user_id WHERE u.email = '${EMAIL}'),
     d AS (SELECT id FROM doctors LIMIT 1),
     a AS (INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
           SELECT p.patient_id, d.id, p.user_id, '${date}', '${start}', '${end}', 'CONFIRMED' FROM p, d RETURNING id, patient_id),
     pay AS (INSERT INTO payments (appointment_id, patient_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, paid_at)
             SELECT a.id, a.patient_id, 'order_PRINTCHECK00000${n}', 'pay_PRINTCHECK00000${n}', ${amount}, 'PAID', now() - interval '${n} days' FROM a RETURNING id)
INSERT INTO refunds (payment_id, amount_paise, reason, status, razorpay_refund_id, idempotency_key, processed_at)
SELECT pay.id, ${refundPaise}, 'Partial refund: cancelled less than 24 hours but at least 2 hours before the appointment.', 'PROCESSED', 'rfnd_PRINTCHECK00000${n}', 'k${n}', now() FROM pay WHERE ${refundPaise} > 0;
`);
const base = new Date();
base.setUTCDate(base.getUTCDate() + 6);
const day = (n) => {
  const x = new Date(base);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
seed(1, day(0), '11:15', '11:45', 65000, 0);
seed(2, day(1), '11:30', '12:00', 65000, 32500);
seed(3, day(2), '10:00', '10:30', 125050, 0);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // The print window itself cannot be driven, so count requests and let the page stay in its "printing" state for measuring.
  await ctx.addInitScript(() => {
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('#email').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.waitForURL(`${BASE}/dashboard`);

  const measure = async (name) => {
    // Lay the page out as the printer will: at the A4 text width (210 mm less 14 mm margins each side), not the screen's.
    await page.setViewportSize({ width: 688, height: 1000 });
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
      const root = document.querySelector('.receipt-print-root');
      const sheets = [...document.querySelectorAll('.receipt-print-root .receipt-sheet')];
      const pageWidth = (210 - 28) * (96 / 25.4); // A4 less 14 mm margins, in CSS px
      return {
        sheets: sheets.length,
        headerShown: shown(document.querySelector('header')),
        sidebarShown: shown(document.querySelector('aside')),
        navShown: shown(document.querySelector('nav')),
        mainShown: shown(document.querySelector('main')),
        buttonsShown: [...document.querySelectorAll('button')].filter(shown).length,
        rootShown: shown(root),
        widest: Math.round(Math.max(0, ...sheets.map((s) => s.getBoundingClientRect().width))),
        pageWidth: Math.round(pageWidth),
        clipped: sheets.filter((s) => s.scrollWidth > s.clientWidth + 1).length,
        overflowing: document.documentElement.scrollWidth > pageWidth + 2,
      };
    });
    await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
    // Last: producing a PDF makes Chromium fire "afterprint", which (correctly) removes the print container.
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    writeFileSync(`${OUT}${name}.pdf`, pdf);
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 1280, height: 900 });
    return { pages: pdfPages(pdf), layout };
  };
  const reset = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); // the browser says this when the print window closes
    await page.waitForTimeout(200);
  };
  const verify = (name, result, expectedSheets) => {
    const { pages, layout } = result;
    console.log(`${name}:`, JSON.stringify(layout), `pages=${pages}`);
    check(layout.sheets === expectedSheets, `${name}: ${expectedSheets} receipt(s) in the print container`);
    check(pages === expectedSheets, `${name}: prints on ${expectedSheets} A4 page(s) (got ${pages})`);
    check(!layout.headerShown && !layout.sidebarShown && !layout.navShown && !layout.mainShown, `${name}: dashboard header, sidebar, navigation and page content hidden`);
    check(layout.buttonsShown === 0, `${name}: no buttons printed (${layout.buttonsShown} shown)`);
    check(layout.widest <= layout.pageWidth + 2, `${name}: receipt fits the A4 text width (${layout.widest}px of ${layout.pageWidth}px)`);
    check(layout.clipped === 0 && !layout.overflowing, `${name}: nothing clipped or sideways-scrolling`);
  };

  await page.goto(`${BASE}/payments`);
  await page.getByRole('list', { name: 'Payments' }).waitFor();

  // 1. From the open receipt: View, then Print receipt.
  await page.getByRole('button', { name: /^View receipt/ }).nth(1).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Print receipt' }).click();
  await page.waitForTimeout(600);
  check((await page.evaluate(() => window.__printed)) === 1, 'dialog Print asks the browser to print once');
  verify('one-receipt-from-dialog', await measure('one-receipt-from-dialog'), 1);
  await reset();
  await page.keyboard.press('Escape');

  // 2. The Print button on a payment card prints that receipt directly.
  await page.getByRole('button', { name: /^Print receipt/ }).first().click();
  await page.waitForTimeout(600);
  verify('one-receipt-from-card', await measure('one-receipt-from-card'), 1);
  await reset();

  // 3. All receipts: one page each.
  await page.getByRole('button', { name: /^Print all receipts/ }).click();
  await page.waitForTimeout(600);
  verify('all-receipts', await measure('all-receipts'), 3);
  await reset();
  check((await page.locator('.receipt-print-root').count()) === 0, 'print container is removed after printing');
} finally {
  await browser.close();
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
