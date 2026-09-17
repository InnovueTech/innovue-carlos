#!/usr/bin/env node
/* Copyright (c) 2026 CARLOS Contributors. SPDX-License-Identifier: GPL-2.0-or-later */
// Uses the existing UI booking fixture. All rows are run-owned and removed in finally.
const { chromium } = require('playwright');
const {
  assert, assertNoPageErrors, assertNotErrorPage, getLaunchOptions, login, wirePage,
} = require('./eform-local-playwright-utils');
const { pickDate } = require('./lib/playwright-ui');
const fixture = require('./appointment-lifecycle-playwright-checks');

async function main() {
  let browser;
  fixture.initMysqlDefaults();
  try {
    browser = await chromium.launch(getLaunchOptions(fixture.config.chromePath));
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript(() => { window.close = () => { window.__carlosSelfCloseRequested = true; }; });
    const daySheet = await login(context, fixture.config, fixture.recorder);
    await fixture.openDaySheet(daySheet);
    const booked = await fixture.bookFromSlot(context, daySheet);
    const dateAfter = (days) => {
      const date = new Date(`${fixture.targetDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    async function recurrence(end, changedReason) {
      const edit = await fixture.openEditPopup(context, daySheet, booked.id, async (dialog, entry) => {
        fixture.recorder.dialogs.push(entry);
        assert(dialog.type() === 'confirm' && /delete/i.test(dialog.message()), 'unexpected recurring-booking dialog');
        await dialog.accept();
      });
      if (changedReason) await edit.locator('#reason').fill(changedReason);
      await edit.locator('#repeatButton').click();
      await edit.locator('#endDate').waitFor({ state: 'visible', timeout: 30000 });
      await assertNotErrorPage(edit, 'recurrence form');
      await pickDate(edit, edit.locator('#endDate'), end);
      await edit.locator('#dateUnitWeek').check();
      return edit;
    }
    async function submit(page, button, expected) {
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST'
          && new URL(r.url()).pathname.endsWith('/appointment/appointmenteditrepeatbooking')),
        page.getByRole('button', { name: button, exact: true }).click(),
      ]);
      assert(response.status() === 200, `${button} returned HTTP ${response.status()}`);
      await page.locator('#recurrence-result').waitFor({ state: 'visible', timeout: 30000 });
      const message = await page.locator('#recurrence-result').innerText();
      assert(expected.test(message), `${button}: unexpected result ${message}`);
      return message;
    }

    let page = await recurrence(dateAfter(-1));
    await submit(page, 'Create repeats', /end date on or after/i);
    assert(fixture.stampedAppointments().length === 1, 'invalid end date wrote appointments');
    // Retry the same form, checking that repeated hidden inputs cannot retain the rejected date.
    await pickDate(page, page.locator('#endDate'), dateAfter(14));
    await submit(page, 'Create repeats', /^2 appointment\(s\) created\.$/);
    await page.close();
    const expectedDates = [dateAfter(0), dateAfter(7), dateAfter(14)];
    let rows = fixture.stampedAppointments();
    assert(JSON.stringify(rows.map((r) => r.date).sort()) === JSON.stringify(expectedDates), 'weekly repeats have wrong dates/count');
    assert(rows.every((r) => r.provider === booked.provider && r.demographic === booked.demographic
      && r.startTime === booked.startTime && r.endTime === booked.endTime && r.notes === booked.notes
      && r.reason === booked.reason), 'created repeats lost appointment fields');

    page = await recurrence(dateAfter(14));
    await submit(page, 'Create repeats', /^No appointments created: repeats already exist/);
    assert(fixture.stampedAppointments().length === 3, 'repeated creation duplicated appointments');
    await page.close();

    const reason = `${fixture.stamp}_recurrence_updated`;
    page = await recurrence(dateAfter(14), reason);
    await submit(page, 'Recurring Update', /^3 appointment\(s\) updated\.$/);
    assert(fixture.stampedAppointments().every((r) => r.reason === reason), 'update missed a recurrence');
    await page.close();

    page = await recurrence(dateAfter(14));
    await submit(page, 'Recurring Cancel', /^3 appointment\(s\) cancelled\.$/);
    assert(fixture.stampedAppointments().every((r) => r.status === 'C'), 'cancel missed a recurrence');
    await page.close();

    page = await recurrence(dateAfter(14));
    const ids = fixture.stampedAppointments().map((r) => r.id);
    await submit(page, 'Recurring Delete', /^3 appointment\(s\) deleted\.$/);
    assert(fixture.stampedAppointments().length === 0, 'delete left an occurrence');
    const archives = fixture.stampedArchiveRows();
    assert(ids.every((id) => archives.filter((row) => row.id === id).length >= 3), 'an occurrence was updated/cancelled/deleted without an archive');
    await page.close();
    assertNoPageErrors(fixture.recorder);
    assert(fixture.recorder.badResponses.length === 0, 'recurrence workflow had HTTP failures');
    assert(fixture.recorder.consoleIssues.length === 0, 'recurrence workflow had console failures');
    console.log('PASS appointment recurrence: invalid range/retry, exact dates and fields, duplicate prevention, group update/cancel/delete and archives');
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      try { fixture.cleanupRows(); }
      finally { fixture.cleanupMysqlDefaults(); }
    }
  }
}
if (require.main === module) main().catch((error) => {
  console.error(`FAIL appointment recurrence: ${error.stack || error.message}`);
  process.exitCode = 1;
});
module.exports = { main };
