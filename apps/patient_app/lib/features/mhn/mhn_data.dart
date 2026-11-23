// My Health Now (MHN) patient-app UI: SAMPLE data of the interactive prototype (UI first, no API yet). Prices, package contents and
// terms are placeholders the prototype itself marks as "sample until Metro Labs confirms". Nothing here is PHI of a real person.
import 'package:flutter/material.dart';

const noFast = 'No fasting';
const memberDiscount = 0.10;
const homeFee = 0;

class MhnCategory {
  const MhnCategory(this.id, this.name, this.sub, this.icon);
  final String id;
  final String name;
  final String sub;
  final IconData icon;
}

class MhnTest {
  const MhnTest({
    required this.id,
    required this.cat,
    required this.name,
    required this.price,
    required this.fasting,
    required this.report,
    required this.age,
    required this.desc,
    this.centre = false,
    this.code = '',
    this.kind = 'test',
    this.sexRestriction,
    this.hasIndicativePrice = true,
    this.bookingKinds = const [],
  });
  final String id;
  final String cat;
  final String name;
  final int price;
  final String fasting;
  final String report;
  final String age;
  final String desc;
  final bool centre;
  final String code;
  final String kind;
  final String? sexRestriction;
  final bool hasIndicativePrice;
  final List<String> bookingKinds;

  bool get needsFasting => fasting.isNotEmpty && fasting != noFast;
  bool get isPanel => kind == 'panel';

  factory MhnTest.fromBookable(Map<String, Object?> map) {
    final id = map['orderable_id'] as String? ?? '';
    final name = map['display_name'] as String? ?? '';
    final code = map['code'] as String? ?? '';
    final kind = map['kind'] as String? ?? 'test';
    final priceObj = map['indicative_price'] is Map
        ? (map['indicative_price'] as Map).cast<String, Object?>()
        : null;
    final pricePaisa = priceObj?['amount_paisa'] is num
        ? (priceObj!['amount_paisa'] as num).toInt()
        : null;
    final price = pricePaisa != null ? pricePaisa ~/ 100 : 0;
    final kinds = map['booking_kinds'] is List
        ? (map['booking_kinds'] as List).cast<String>()
        : <String>[];
    final sex = map['sex_restriction'] as String?;
    final isCentre = kinds.contains('centre_visit') && !kinds.contains('home_collection');

    return MhnTest(
      id: id,
      cat: kind == 'panel' ? 'packages' : 'general',
      name: name.isNotEmpty ? name : code,
      price: price,
      fasting: noFast,
      report: '',
      age: '',
      desc: code.isNotEmpty && code != name ? 'Code: $code' : '',
      centre: isCentre,
      code: code,
      kind: kind,
      sexRestriction: sex,
      hasIndicativePrice: pricePaisa != null,
      bookingKinds: kinds,
    );
  }
}

class MhnPackage {
  const MhnPackage(this.id, this.name, this.price, this.params, this.color, this.feats);
  final String id;
  final String name;
  final int price;
  final String params;
  final Color color;
  final List<String> feats;
}

class MhnFaq {
  const MhnFaq(this.q, this.a);
  final String q;
  final String a;
}

class MhnPayMethod {
  const MhnPayMethod(this.id, this.label, this.sub);
  final String id;
  final String label;
  final String sub;
}

class MhnPlan {
  const MhnPlan(this.id, this.name, this.price, this.color, this.desc);
  final String id;
  final String name;
  final int price;
  final Color color;
  final String desc;
}

class MhnHeroSlide {
  const MhnHeroSlide(this.tag, this.title, this.sub, this.cta, this.go);
  final String tag;
  final String title;
  final String sub;
  final String cta;
  final String go; // packages | tests | membership
}

const kCategories = <MhnCategory>[
  MhnCategory('organs', 'Vital organs', 'Liver, kidney, heart and thyroid tests.', Icons.monitor_heart_outlined),
  MhnCategory('hormones', 'Hormones, diabetes & blood', 'Blood sugar, HbA1c and blood counts.', Icons.water_drop_outlined),
  MhnCategory('illness', 'Illness & infection', 'Fever, dengue, typhoid and urine infections.', Icons.thermostat_outlined),
  MhnCategory('life', 'Life stage & family care', 'Pregnancy, antenatal and age-related checks.', Icons.groups_2_outlined),
  MhnCategory('lifestyle', 'Lifestyle & nutrition', 'Uric acid, minerals and salt balance.', Icons.eco_outlined),
  MhnCategory('special', 'Specialised screenings', 'Screening and monitoring tests your doctor may order.', Icons.biotech_outlined),
  MhnCategory('imaging', 'X-ray & imaging', 'X-ray and ultrasound at the centre.', Icons.center_focus_strong_outlined),
  MhnCategory('vitamins', 'Vitamins & deficiencies', 'Vitamin D, B12 and iron.', Icons.medication_outlined),
];

const kTests = <MhnTest>[
  MhnTest(id: 'lft', cat: 'organs', name: 'LFT Advanced', price: 1500, fasting: noFast, report: 'Same day', age: 'Adults', desc: 'Checks how well your liver is working.'),
  MhnTest(id: 'kft', cat: 'organs', name: 'Kidney Function Test', price: 900, fasting: noFast, report: 'Same day', age: 'Adults, yearly after 40', desc: 'Urea, creatinine and electrolytes for kidney health.'),
  MhnTest(id: 'lipid', cat: 'organs', name: 'Lipid Profile', price: 1200, fasting: 'Fasting 10–12 h', report: 'Same day', age: 'Adults, every 1–2 years', desc: 'Cholesterol and triglycerides for heart risk.'),
  MhnTest(id: 'tft', cat: 'organs', name: 'Thyroid Function Test', price: 1200, fasting: noFast, report: 'Next day', age: 'Adults', desc: 'T3, T4 and TSH for an over- or under-active thyroid.'),
  MhnTest(id: 'fbs', cat: 'hormones', name: 'Glucose, Fasting', price: 200, fasting: 'Fasting 8–10 h', report: 'Same day', age: 'Adults', desc: 'Blood sugar after an overnight fast.'),
  MhnTest(id: 'hba1c', cat: 'hormones', name: 'HbA1c', price: 1000, fasting: noFast, report: 'Same day', age: 'Adults; every 3 months if diabetic', desc: 'Average blood sugar over the last 2–3 months.'),
  MhnTest(id: 'cbc', cat: 'hormones', name: 'Complete Blood Count (CBC)', price: 500, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Red cells, white cells and platelets.'),
  MhnTest(id: 'hb', cat: 'hormones', name: 'Hemoglobin', price: 150, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Screens for anaemia.'),
  MhnTest(id: 'fever', cat: 'illness', name: 'Fever Panel Essential', price: 1800, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Common causes of fever, including dengue and typhoid markers.'),
  MhnTest(id: 'dengue', cat: 'illness', name: 'Dengue NS1 Antigen', price: 1200, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Early dengue detection in the first days of fever.'),
  MhnTest(id: 'widal', cat: 'illness', name: 'Widal Test', price: 350, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Typhoid screening.'),
  MhnTest(id: 'ure', cat: 'illness', name: 'Urine Routine Examination', price: 200, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Urinary infection and kidney screening.'),
  MhnTest(id: 'bhcg', cat: 'life', name: 'Pregnancy Test (Beta hCG)', price: 900, fasting: noFast, report: 'Same day', age: 'Women', desc: 'Confirms pregnancy from a blood sample.'),
  MhnTest(id: 'anc', cat: 'life', name: 'Antenatal Profile', price: 2500, fasting: noFast, report: 'Next day', age: 'Pregnant women', desc: 'Routine tests in early pregnancy.'),
  MhnTest(id: 'psa', cat: 'life', name: 'PSA (Prostate)', price: 1500, fasting: noFast, report: 'Next day', age: 'Men over 50', desc: 'Prostate health screening.'),
  MhnTest(id: 'uric', cat: 'lifestyle', name: 'Uric Acid', price: 300, fasting: noFast, report: 'Same day', age: 'Adults', desc: 'Gout and joint pain screening.'),
  MhnTest(id: 'calcium', cat: 'lifestyle', name: 'Serum Calcium', price: 350, fasting: noFast, report: 'Same day', age: 'Adults', desc: 'Bone and muscle health.'),
  MhnTest(id: 'elec', cat: 'lifestyle', name: 'Electrolytes (Na, K, Cl)', price: 600, fasting: noFast, report: 'Same day', age: 'All ages', desc: 'Hydration and salt balance.'),
  MhnTest(id: 'pap', cat: 'special', name: 'Pap Smear', price: 1500, fasting: noFast, report: '3–5 days', age: 'Women 25–65', desc: 'Cervical cancer screening.'),
  MhnTest(id: 'cea', cat: 'special', name: 'CEA', price: 1800, fasting: noFast, report: 'Next day', age: 'As advised by a doctor', desc: 'Tumour marker used for monitoring.'),
  MhnTest(id: 'cxr', cat: 'imaging', name: 'Chest X-ray (PA view)', price: 600, fasting: noFast, report: 'Same day', age: 'As advised by a doctor', desc: 'Lungs and heart outline.', centre: true),
  MhnTest(id: 'usg', cat: 'imaging', name: 'USG Abdomen & Pelvis', price: 1800, fasting: 'Fasting 6 h, full bladder', report: 'Same day', age: 'As advised by a doctor', desc: 'Ultrasound of the abdominal organs.', centre: true),
  MhnTest(id: 'vitd', cat: 'vitamins', name: 'Vitamin D (25-OH)', price: 2500, fasting: noFast, report: 'Next day', age: 'Adults', desc: 'A common deficiency that affects bones and immunity.'),
  MhnTest(id: 'b12', cat: 'vitamins', name: 'Vitamin B12', price: 1500, fasting: noFast, report: 'Next day', age: 'Adults, vegetarians', desc: 'Nerve health and anaemia.'),
  MhnTest(id: 'iron', cat: 'vitamins', name: 'Iron Profile', price: 1200, fasting: noFast, report: 'Next day', age: 'Adults', desc: 'Iron levels and stores, for anaemia.'),
];

/// The four tests the home screen lists as "Popular tests" (prototype order).
const kPopularIds = <String>['cbc', 'fbs', 'hba1c', 'lft'];

const kPackages = <MhnPackage>[
  MhnPackage('bronze', 'Bronze', 2999, '119 parameters', Color(0xFF7A4E2D), ['Complete blood count', 'Blood sugar', 'Liver function', 'Kidney function']),
  MhnPackage('silver', 'Silver', 4499, '[N] parameters', Color(0xFF56636B), ['Everything in Bronze', 'Lipid profile', 'Thyroid profile', 'Urine routine']),
  MhnPackage('gold', 'Gold', 6499, '[N] parameters', Color(0xFF86640F), ['Everything in Silver', 'HbA1c', 'Vitamin D', 'Uric acid']),
  MhnPackage('platinum', 'Platinum', 8999, '[N] parameters', Color(0xFF3B4759), ['Everything in Gold', 'Vitamin B12', 'Iron profile', 'Electrolytes']),
  MhnPackage('elite', 'Elite', 12999, '[N] parameters', Color(0xFF0E4B3B), ['Everything in Platinum', 'Cardiac markers', 'Chest X-ray', 'Doctor consultation']),
];

const kFaqs = <MhnFaq>[
  MhnFaq('Do I need to fast before my test?', 'Some tests, such as fasting glucose and the lipid profile, need 8–12 hours without food. Water is fine. Every test card shows whether fasting is needed.'),
  MhnFaq('How does home sample collection work?', 'Pick a date and time when you book. A phlebotomist visits your address in that slot and brings the sample to the lab.'),
  MhnFaq('When will my report be ready?', 'Each test shows its report time. You get a notification when the report is ready, and it appears in Profile › Reports.'),
  MhnFaq('Can I book for my family?', 'Yes. Add them in Profile › Other members, then choose them in “Who is this for?” when you book.'),
  MhnFaq('Which payment methods can I use?', 'eSewa, Khalti, Fonepay, a debit or credit card, or cash on collection.'),
  MhnFaq('Can I cancel or reschedule a booking?', '[Cancellation and rescheduling policy to be confirmed by Metro Labs.]'),
];

const kHero = <MhnHeroSlide>[
  MhnHeroSlide('Health packages', 'Looking for a full body checkup?', 'Five packages, from Bronze to Elite.', 'See packages', 'packages'),
  MhnHeroSlide('At your door', 'Home sample collection', 'A phlebotomist comes to you at the time you pick.', 'Book a test', 'tests'),
  MhnHeroSlide('Laboratory tests', 'Accurate & verified reports', 'Comprehensive test profiles with barcoded sample tracking.', 'View tests', 'tests'),
];

const kPlaceholders = <String>['Thyroid profile', 'CBC', 'HbA1c', 'Vitamin D', 'Lipid profile'];
const kSlots = <String>['7:00–8:00 AM', '8:00–9:00 AM', '9:00–10:00 AM', '10:00–11:00 AM', '1:00–2:00 PM', '4:00–5:00 PM'];

const kPays = <MhnPayMethod>[
  MhnPayMethod('esewa', 'eSewa', 'Wallet'),
  MhnPayMethod('khalti', 'Khalti', 'Wallet'),
  MhnPayMethod('fonepay', 'Fonepay', 'Scan to pay with your bank app'),
  MhnPayMethod('card', 'Debit or credit card', 'Visa, Mastercard'),
  MhnPayMethod('cash', 'Pay on collection', 'Cash or QR to the phlebotomist'),
];

const kPlans = <MhnPlan>[
  MhnPlan('individual', 'Individual Membership', 999, Color(0xFF0E4B3B), 'For you. Member prices and free home collection for a year.'),
  MhnPlan('family', 'Family Membership', 1999, Color(0xFF7A5A12), 'For you and up to 4 family members on this account.'),
];

const kBlood = <String>['A+', 'A−', 'B+', 'B−', 'O+', 'O−', 'AB+', 'AB−'];
const kRelations = <String>['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Other'];
const kGenders = <String>['Male', 'Female', 'Other'];
const kProblems = <String>['Booking', 'Payment', 'Report', 'Home collection', 'App not working', 'Other'];

const kAgeBands = <(String, String)>[('<30', 'years'), ('30–45', 'years'), ('45–60', 'years'), ('60+', 'years')];

/// One sample report (CBC) shown in the report detail screen.
const kReportValues = <(String, String, String, String)>[
  ('Hemoglobin', '14.2 g/dL', '13.0–17.0', 'Normal'),
  ('WBC count', '7,800 /µL', '4,000–11,000', 'Normal'),
  ('Platelets', '1,42,000 /µL', '1,50,000–4,50,000', 'Low'),
  ('RBC count', '5.1 M/µL', '4.5–5.9', 'Normal'),
];

/// "Rs 12,999", "Rs 1,42,000": Indian digit grouping like the prototype's toLocaleString('en-IN').
String rs(num n) {
  final s = n.round().toString();
  if (s.length <= 3) return 'Rs $s';
  final head = s.substring(0, s.length - 3);
  final tail = s.substring(s.length - 3);
  final buf = StringBuffer();
  for (var i = 0; i < head.length; i++) {
    if (i > 0 && (head.length - i).isEven) buf.write(',');
    buf.write(head[i]);
  }
  return 'Rs $buf,$tail';
}

const _weekdays = <String>['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = <String>['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
String weekdayShort(DateTime d) => _weekdays[d.weekday - 1];
String monthShort(DateTime d) => _months[d.month - 1];
String dateLong(DateTime d) => '${d.day} ${monthShort(d)} ${d.year}';

int? ageFrom(String iso) {
  final d = DateTime.tryParse(iso);
  if (d == null) return null;
  final n = DateTime.now();
  var a = n.year - d.year;
  if (n.month < d.month || (n.month == d.month && n.day < d.day)) a--;
  return a;
}
