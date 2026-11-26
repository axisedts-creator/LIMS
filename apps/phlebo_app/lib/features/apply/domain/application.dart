// PHLEBO-UI-FULL-1 (founder request 2026-11-26): a person applies to work as a phlebotomist. Pure model + validation.
// Nothing here is patient data; it is the applicant's own data and is sent once, never stored on the phone.

/// Nepal mobile entry: the applicant types the 10-digit number; the app sends E.164.
/// Accepts spaces/dashes and an optional +977 / 977 / 0 prefix. Returns null when it is not a Nepal mobile number.
String? nepalMobileToE164(String input) {
  var d = input.replaceAll(RegExp(r'[\s\-()]'), '');
  if (d.startsWith('+977')) {
    d = d.substring(4);
  } else if (d.startsWith('977') && d.length == 13) {
    d = d.substring(3);
  } else if (d.startsWith('0') && d.length == 11) {
    d = d.substring(1);
  }
  // Nepal mobile numbers are 10 digits starting 96, 97 or 98.
  return RegExp(r'^9[678]\d{8}$').hasMatch(d) ? '+977$d' : null;
}

enum Employment { fullTime, partTime }

enum ShiftCount { single, double }

enum DaySlot { morning, afternoon, evening }

const daySlotLabels = {DaySlot.morning: 'Morning', DaySlot.afternoon: 'Afternoon', DaySlot.evening: 'Evening'};

enum DocKind { licence, trainingCertificate, identity, photo }

const docLabels = {
  DocKind.licence: 'Licence or council registration',
  DocKind.trainingCertificate: 'Training certificates',
  DocKind.identity: 'Citizenship or ID',
  DocKind.photo: 'Your photo',
};

/// Wire codes (server enum values).
const docCodes = {
  DocKind.licence: 'licence',
  DocKind.trainingCertificate: 'training_certificate',
  DocKind.identity: 'identity',
  DocKind.photo: 'photo',
};

const maxFileBytes = 2 * 1024 * 1024;
const maxFilesPerKind = {DocKind.licence: 1, DocKind.trainingCertificate: 5, DocKind.identity: 2, DocKind.photo: 1};
const allowedExtensions = {'jpg', 'jpeg', 'png', 'pdf'};

class PickedFile {
  const PickedFile({required this.name, required this.bytes});

  final String name;
  final List<int> bytes;

  String get extension => name.contains('.') ? name.split('.').last.toLowerCase() : '';

  String get contentType => switch (extension) { 'pdf' => 'application/pdf', 'png' => 'image/png', _ => 'image/jpeg' };

  /// Null when acceptable, else the sentence to show.
  String? problem(DocKind kind) {
    if (!allowedExtensions.contains(extension) || (kind == DocKind.photo && extension == 'pdf')) {
      return kind == DocKind.photo ? 'Use a JPG or PNG photo.' : 'Use a JPG, PNG or PDF file.';
    }
    if (bytes.isEmpty) return 'This file is empty.';
    if (bytes.length > maxFileBytes) return 'This file is larger than 2 MB.';
    return null;
  }
}

class ApplicationDraft {
  String fullName = '';
  String phone = '';
  String email = '';
  String area = '';
  Employment? employment;
  ShiftCount? shiftCount;
  final Set<DaySlot> slots = {};
  final Map<DocKind, List<PickedFile>> documents = {for (final k in DocKind.values) k: []};
  bool declared = false;

  String? get phoneE164 => nepalMobileToE164(phone);

  /// field -> sentence. Empty = ready to send.
  Map<String, String> problems() {
    final out = <String, String>{};
    final name = fullName.trim();
    if (name.length < 3 || name.length > 120) out['fullName'] = 'Enter your full name.';
    if (phoneE164 == null) out['phone'] = 'Enter your 10-digit mobile number.';
    final mail = email.trim();
    if (mail.length < 6 || mail.length > 254 || !RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(mail)) out['email'] = 'Enter your email address.';
    if (area.trim().isEmpty || area.trim().length > 120) out['area'] = 'Enter the area you live in.';
    if (employment == null) out['employment'] = 'Choose full time or part time.';
    if (employment == Employment.partTime) {
      if (shiftCount == null) {
        out['shift'] = 'Choose a single or double shift.';
      } else if (slots.length != (shiftCount == ShiftCount.single ? 1 : 2)) {
        out['slots'] = shiftCount == ShiftCount.single ? 'Choose one time of day.' : 'Choose two times of day.';
      }
    }
    for (final kind in const [DocKind.licence, DocKind.trainingCertificate, DocKind.identity, DocKind.photo]) {
      if (documents[kind]!.isEmpty) out['doc.${kind.name}'] = 'Add: ${docLabels[kind]}.';
    }
    if (!declared) out['declared'] = 'Confirm that your details and documents are true.';
    return out;
  }

  /// The JSON body (documents are uploaded separately).
  Map<String, Object?> toJson() => {
        'full_name': fullName.trim(),
        'phone_e164': phoneE164,
        'email': email.trim().toLowerCase(),
        'area': area.trim(),
        'employment_type': employment == Employment.fullTime ? 'full_time' : 'part_time',
        if (employment == Employment.partTime) ...{
          'shift_count': shiftCount == ShiftCount.single ? 'single' : 'double',
          'day_slots': [for (final s in DaySlot.values) if (slots.contains(s)) s.name],
        },
      };
}
