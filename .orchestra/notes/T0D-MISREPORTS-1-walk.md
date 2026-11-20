# T0D-MISREPORTS-1 walk (writer, done_when 1)
Walked first: the LIMS analytics report screens that exist. The hub /analytics/reports (title MIS Report, 12 tabs: Income, Departments, Collections, Volume, Referrers, Centres, Tests done, TAT, Pending tests, Quality, Delivery, Interfaces), /analytics/collections, /analytics/referral-incentive, My exports, Scheduled reports and the report run page. Every one reads its own GET operation; the schedule editor and the export dialog list REPORT_CODES (14 rows). The 11 new contract definitions (x-report-definitions, T0C-MISREPORTS-1) were missing from all of them: no catalogue row, no screen, no schedule checkbox. Evidence file C:/LIMS-state/elabassist-other-20261117.md is not readable in this sandbox; the ElabAssist names below are the field map of notes/T0C-MISREPORTS-1-impl.md.

Each new definition and the ElabAssist report it replaces (all now catalogue rows: screen, CSV export, schedule):
- bill_of_the_day: replaces ElabAssist Bill Of The Day (accounting walk) and Patient Bill Report. Own screen /billing/bill-of-the-day (day picker, bill list, totals by payment mode, print).
- two_level_commission: replaces the ElabAssist two level commission report (accounting walk). Behind the A39 gate (flag referralIncentiveReportEnabled, analytics.referral_report.read, aal2).
- sales_representative: replaces ElabAssist Sales Representative.
- consultant: replaces ElabAssist Consultant MIS (volume only, no amount, A39-3).
- collection_boy: replaces ElabAssist CollectionBoy Details (Collection Boy).
- repeated_patient: replaces ElabAssist Repeated and Non Repeated MIS, patient side.
- repeated_test: replaces ElabAssist Repeated and Non Repeated MIS, test side.
- ipd_opd: replaces ElabAssist Doctor Accounts IPD/OPD, Laboratory IPD/OPD and Franchise IPD/OPD (one report, referrer and party filters).
- tds: replaces ElabAssist EntityBilling With TDS (TDS report). Behind the same A39 gate as two_level_commission.
- party_billing: replaces ElabAssist Company Details, Client Details, Client Postpaid Bill, CASH PARTY Report and CREDIT PARTY Report (Party / Company / Client).
- outsource: replaces ElabAssist OutSource Report and InterLab Transfer MIS (Outsource and inter lab transfer).

Already present before this task (unchanged): Doctor Accounts (top_referrers, referral_incentive), Laboratory Summary and Sales Report (income, volume), Laboratory Details and Test Details (tests_done), Franchise (top_centres), Dispatch Sheet (delivery), Payment History and Daily Payment History (collections), TAT Details (tat), Critical Value MIS (quality_indicators).

Still missing after this task:
- On screen rows, totals row, cursor paging and cell formats of all 11 reports: no HTTP read exists for the definitions (CR notes/T0D-MISREPORTS-1-cr-needed.md). The screens draw the contract header row and an empty state that points to the CSV export and the schedule.
- Totals by payment mode on Bill Of The Day: the definition has no payment mode column (same CR). The table draws its header only.
- A search picker for Party, Representative and Collector filters: the analytics contract has no lookup for them; the choice is carried in the URL and can be cleared. Consultant uses the existing referrer search.
- Patient Details (PHI, frontdesk patient search covers it) is not a report by decision of T0C-MISREPORTS-1.
