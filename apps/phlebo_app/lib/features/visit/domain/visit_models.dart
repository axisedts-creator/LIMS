// HC-T26: read-only view models the visit-flow screens render (built by the caller from the cache DB + config; synthetic in tests).
// The patient fields are display-only: none of them is ever copied into a mutation payload or label (no PHI in the outbox).

class ExpectedTube {
  const ExpectedTube({
    required this.specimenId,
    required this.typeCode,
    required this.typeDisplay,
    required this.container,
    required this.barcode,
  });

  final String specimenId;
  final String typeCode;
  final String typeDisplay;
  final String container;
  final String barcode;

  /// "…0042": only the last 4 characters are ever shown (04-UI-UX §3.3).
  String get last4 => '…${barcode.length <= 4 ? barcode : barcode.substring(barcode.length - 4)}';
}

class VisitView {
  const VisitView({
    required this.visitId,
    required this.sequence,
    required this.patientName,
    required this.phone,
    required this.birthDate,
    required this.secondIdentifier,
    required this.address,
    required this.landmark,
    required this.windowStart,
    required this.windowEnd,
    required this.noteFromCentre,
    required this.orderId,
    required this.amountDuePaisa,
    required this.amountAsOf,
    required this.specimensStale,
    required this.tubes,
  });

  final String visitId;
  final int sequence;
  final String patientName;
  final String phone;
  final String birthDate;

  /// 'phone' | 'birth_date' (M4 compares the name plus this one).
  final String secondIdentifier;
  final String address;
  final String landmark;
  final String windowStart;
  final String windowEnd;
  final String? noteFromCentre;
  final String orderId;
  final int amountDuePaisa;
  final String amountAsOf;
  final bool specimensStale;
  final List<ExpectedTube> tubes;

  /// Sequence + window, never a name (TRD §6.3 / M11): the outbox `visit_label`.
  String get label => '#$sequence · $windowStart–$windowEnd';
}

class ReasonOption {
  const ReasonOption({required this.code, required this.display, required this.requiresText});

  final String code;
  final String display;
  final bool requiresText;
}

class PaymentMethodOption {
  const PaymentMethodOption({required this.code, required this.display, required this.requiresReference});

  final String code;
  final String display;
  final bool requiresReference;
}

class VisitConfig {
  const VisitConfig({
    required this.mapHandoffEnabled,
    required this.manualBarcodeEntryAllowed,
    required this.consentText,
    required this.consentTextVersion,
    required this.paymentMethods,
    required this.visitFailReasons,
    required this.notCollectedReasons,
  });

  final bool mapHandoffEnabled;
  final bool manualBarcodeEntryAllowed;
  final String consentText;
  final String consentTextVersion;
  final List<PaymentMethodOption> paymentMethods;
  final List<ReasonOption> visitFailReasons;
  final List<ReasonOption> notCollectedReasons;
}

/// Integer paisa -> "1,800.00" (no binary floats anywhere).
String formatPaisa(int paisa) {
  final rupees = (paisa ~/ 100).toString();
  final buf = StringBuffer();
  for (var i = 0; i < rupees.length; i++) {
    if (i > 0 && (rupees.length - i) % 3 == 0) buf.write(',');
    buf.write(rupees[i]);
  }
  return '$buf.${(paisa % 100).toString().padLeft(2, '0')}';
}

/// Integer paisa -> "1800.00" (the text a money field starts with).
String paisaToInput(int paisa) => '${paisa ~/ 100}.${(paisa % 100).toString().padLeft(2, '0')}';
