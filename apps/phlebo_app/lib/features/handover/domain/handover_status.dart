// Chain-of-custody states the phone shows after "Hand over" (03-APP-FLOW §1.3, web W3): pending until the centre scans
// the tubes, confirmed when every tube was received, discrepancy when a tube is missing (dispatch is told).
enum HandoverStatus { pending, confirmed, discrepancy }

class HandoverReceipt {
  const HandoverReceipt({required this.centreName, required this.handedOverAt, required this.tubes, this.status = HandoverStatus.pending, this.missingCount = 0});

  final String centreName;
  final DateTime handedOverAt;

  /// "Serum · …0042": last 4 of the barcode only.
  final List<String> tubes;
  final HandoverStatus status;
  final int missingCount;
}
