# Moved out of T0B-MISREPORTS-1 by LD-346 (2), verbatim, for T0B-MISREPORTS-2.
Tester of that task: re-add the cases below to services/api/src/modules/analytics/__tests__/misreports/gates.test.ts (they use MONEY_CODES and isMoney from contract.ts), re-add commission.live.test.ts (T0B-MISREPORTS-2-commission.live.test.ts.txt, was misreports/commission.live.test.ts), and re-add the money rows to registry.static.test.ts / domain/__tests__/reportRegistry.test.ts when the codes leave PENDING_REPORT_CODES.

```ts
  it.each(MONEY_CODES)('%s: flag off (default, or false) -> 403 common.feature_disabled; no row, no job, no log; nobody is exempt', async (code) => {
    for (const flag of [undefined, false]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, flag === undefined ? {} : { flag });
      await expectLims(create(c, code), 'common.feature_disabled', 403);
      untouched(); expect(c.entries).toEqual([]);
    }
  });

  it.each(MONEY_CODES)('%s: holder at aal1 -> 403 auth.mfa_required; nothing written (flag on or off)', async (code) => {
    for (const flag of [undefined, true]) {
      db15.reset();
      const c = await makeCtx15(OWNER_AAL1, flag === undefined ? {} : { flag });
      await expectLims(create(c, code), 'auth.mfa_required', 403);
      untouched(); expect(c.entries).toEqual([]);
    }
  });

  it.each(MONEY_CODES)('%s: the access log gets referral_report.view with the report code (A39-2c), once, next to data.export', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    await okExp('createAnalyticsExport', c.ctx, { body: body(code) }, 202);
    const views = c.entries.filter((e: any) => e.action === 'referral_report.view');
    expect(views).toHaveLength(1);
    expect(views[0].detail).toMatchObject({ report_code: code });
    expect(JSON.stringify(c.entries)).not.toMatch(/commission_paisa|tds_withheld/); // ids, codes, dates only (E4): never an amount
  });


  it.each(MONEY_CODES)('%s: the tenant admin (no analytics.referral_report.read) cannot schedule it, at create or at update; the stored schedule is unchanged', async (code) => {
    const c = await makeCtx16(ADMIN);
    await expectLims(callSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: ['income', code] }) }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.size).toBe(0);
    seedSchedule(1, ADMIN);
    await expectLims(callSch('updateReportSchedule', (await makeCtx16(ADMIN)).ctx, { params: { schedule_id: sid(1) }, body: scheduleBody({ report_codes: [code] }), ifMatch: ifm(1) }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.get(sid(1))!.report_codes).toEqual(['income']);
  });
```
