// HC-T27 M10: a centre to hand tubes to, and a collected tube waiting for handover. No patient fields.
class HandoverCentre {
  const HandoverCentre({required this.centreId, required this.name});

  final String centreId;
  final String name;
}

class HandoverTube {
  const HandoverTube({required this.specimenId, required this.typeDisplay, required this.barcode});

  final String specimenId;
  final String typeDisplay;
  final String barcode;
}
