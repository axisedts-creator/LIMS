# T0D-FIX-5 left (writer): operations still on the 503 placeholder (CR DEPLOY-AXIS-012 item 1)
Reason: each moves money, calls a provider or stores a credential (LD-310 founder exclusions), and the api runtime supplies no payments jobs / events / gateway adapters yet (PaymentProviderPort.impl.ts note).
- recheckPaymentIntent, resolvePaymentIntent, cancelPaymentIntent: gateway lookup (adapters).
- createPaymentRefundRequest, approvePaymentRefund, rejectPaymentRefund, recheckPaymentRefund, confirmManualPaymentRefund, failManualPaymentRefund: refund money flow (port refund, jobs, gateway check).
- startReconciliationRun: enqueues payments.reconcile_batch (no job runtime in the api handlers).
- putMerchantAccount, testMerchantAccount: gateway credentials and a live provider probe (founder decision).
- launchEsewaPayment, esewaSuccessCallback, esewaFailureCallback, khaltiReturnCallback: callback service + adapters + paymentCallback resolver (PG-T09).
Web: refund request / approve, run reconciliation and gateway save buttons answer 503 until these are wired.
- LD-449 (b) service name: loadPaymentsConfig has no service-name input; the message names the variable, the value it has, the value it expects and the fix (same value on web, api and worker). Adding a name needs a LIMS_CORE_SERVICE_NAME-style input (CR).
