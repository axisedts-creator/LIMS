// PG-T08: shared PaymentProviderPort contract suite (IC §4.9 cases 1-11 + CR-C15-001 cases 12-18) on the REAL port implementation.
// Harness: helpers/portHarness.ts (real createPaymentProviderPort over the in-memory DB fake, scripted gateways). See its header for the wiring seam.
// Cases 8, 9 and 18 exercise `refund`, which is PG-T14's task (06-PLAN: PG-T14 "port `refund`"); until then `refund` stays the PG-T01 stub, so those three are
// skipped HERE with an explicit reason and must be green when PG-T14 lands (the same suite is re-run for it). Nothing else is skipped.
// Fails now: ports/PaymentProviderPort.impl.ts does not export createPaymentProviderPort.
import { beforeEach, expect } from 'vitest';
import { runPaymentProviderPortContract } from '../../../../../../../packages/fakes/contract-tests/PaymentProviderPort.contract';
import { makePortHarness } from '../helpers/portHarness';

beforeEach((t) => {
  const name = expect.getState().currentTestName ?? '';
  if (/\((8|9|18)\) /.test(name)) t.skip(); // refund cases: PG-T14
});

runPaymentProviderPortContract(makePortHarness);
