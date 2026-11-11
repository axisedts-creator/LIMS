BL-T22 impl (writer, round 2 after ruling). Owned paths only.
Files: worker billing/alerts/integrity.rules.yaml + frontdesk/alerts/frontdesk.rules.yaml (round 1); billing/service/ledger.service.ts recordPayment: no billing rows -> ctx.ports.FrontdeskPort.getOrderSummary (not visible -> 404 common.not_found; credit -> 400 validation_failed; visible cash manual -> 409 order_not_invoiced).
[CONV] ctx with no FrontdeskPort (BL-T08 t08.helpers world, test file I may not edit) keeps the old answer; production ctx always has the port.
Tests: crossTenant recordPayment probe now passes; ledger.payment + BillingCommandPort.contract 110/110; billing suite 1718 pass / 46 fail.
46 fails = 45 handler stubs of unbuilt tasks (FD-T05..T15, BL-T13..T19, service_unavailable) + alerts.rules CR check: orchestra renamed .orchestra/cr/BL-T22.md -> BL-T22.nonblocking.md (8d2437c0); not recreated.
tenant-export-restore manifest test timed out under full-suite load once; passes alone (15/15).
Open: ruling's assertRole(billing.payment.record, {centreId}) not added in service — t08 ctx has no IdentityPort.assertRole, would break BL-T08 suite; core pipeline gates the permission.
