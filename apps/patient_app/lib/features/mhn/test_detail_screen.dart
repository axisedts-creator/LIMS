// Test description & booking screen: clinical overview, biomarkers, prep guidelines, sample collection, and direct booking flow.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'book_screen.dart';
import 'cart_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnTestDetailScreen extends ConsumerStatefulWidget {
  const MhnTestDetailScreen({super.key, required this.test});
  final MhnTest test;

  @override
  ConsumerState<MhnTestDetailScreen> createState() => _MhnTestDetailScreenState();
}

class _MhnTestDetailScreenState extends ConsumerState<MhnTestDetailScreen> {
  bool _expandedParameters = true;

  List<String> _getParametersForTest(MhnTest t) {
    final id = t.id.toLowerCase();
    final code = t.code.toUpperCase();
    if (id.contains('cbc') || code == 'CBC' || code == 'HM010') {
      return const [
        'Hemoglobin (Hb)',
        'Total White Blood Cell (WBC)',
        'Red Blood Cell (RBC) Count',
        'Platelet Count',
        'Packed Cell Volume (PCV / Hematocrit)',
        'Mean Corpuscular Volume (MCV)',
        'Mean Corpuscular Hemoglobin (MCH)',
        'MCH Concentration (MCHC)',
        'Neutrophils %',
        'Lymphocytes %',
        'Monocytes %',
        'Eosinophils %',
        'Basophils %',
      ];
    }
    if (t.parameters.trim().isNotEmpty) {
      final rawList = t.parameters
          .split(RegExp(r'[,;\n]|\s{2,}'))
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty && s.length > 1)
          .toList();
      if (rawList.isNotEmpty) return rawList;
    }
    if (id.contains('lipid') || code == 'ML022') {
      return const [
        'Total Cholesterol',
        'HDL (Good Cholesterol)',
        'LDL (Bad Cholesterol)',
        'VLDL Cholesterol',
        'Triglycerides',
        'TC / HDL Ratio',
        'LDL / HDL Ratio',
      ];
    }
    if (id.contains('lft') || code == 'ML002') {
      return const [
        'Bilirubin Total',
        'Bilirubin Direct (Conjugated)',
        'Bilirubin Indirect',
        'SGOT / AST (Liver enzyme)',
        'SGPT / ALT (Liver enzyme)',
        'Alkaline Phosphatase (ALP)',
        'Total Protein',
        'Serum Albumin',
        'Serum Globulin',
        'A:G Ratio',
      ];
    }
    if (id.contains('kft') || code == 'ML032') {
      return const [
        'Blood Urea Nitrogen (BUN)',
        'Serum Creatinine',
        'Serum Uric Acid',
        'Urea / Creatinine Ratio',
        'Sodium (Na+)',
        'Potassium (K+)',
        'Chloride (Cl-)',
        'Estimated GFR (eGFR)',
      ];
    }
    if (id.contains('tft') || id.contains('thyroid')) {
      return const [
        'Thyroid Stimulating Hormone (TSH, Ultrasensitive)',
        'Total Triiodothyronine (T3)',
        'Total Thyroxine (T4)',
      ];
    }
    if (id.contains('hba1c') || id.contains('sugar') || id.contains('glucose')) {
      return const [
        'Glycated Hemoglobin (HbA1c)',
        'Estimated Average Glucose (eAG)',
        'Fasting Blood Sugar (FBS)',
      ];
    }
    if (id.contains('vit') || id.contains('d3')) {
      return const [
        '25-Hydroxy Vitamin D Total',
        'Vitamin D2 (Ergocalciferol)',
        'Vitamin D3 (Cholecalciferol)',
      ];
    }
    return [
      '${t.name} Primary Quantitative Assay',
      'Biological Reference Range Evaluation',
      'Clinical Pathologist Review & Correlation',
      'Automated Analytical QC Verified',
    ];
  }

  String _getSampleType(MhnTest t) {
    if (t.sampleType.trim().isNotEmpty) {
      final container = t.container.trim().isNotEmpty ? ' (${t.container})' : '';
      return '${t.sampleType}$container';
    }
    if (t.name.toLowerCase().contains('urine')) return 'Urine (Midstream, 20 mL)';
    if (t.name.toLowerCase().contains('x-ray') || t.centre) return 'In-Centre Scan / Imaging';
    return 'Blood (3 mL Serum / EDTA Vacutainer)';
  }

  int _getMrp(MhnTest t) {
    if (t.mrp > t.price) return t.mrp;
    if (t.price <= 0) return 0;
    return (t.price * 1.33 / 10).round() * 10;
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.test;
    final inCart = ref.watch(mhnProvider.select((s) => s.cart.contains(t.id)));
    final mrp = _getMrp(t);
    final params = _getParametersForTest(t);
    final sampleType = _getSampleType(t);
    final catMatches = kCategories.where((c) => c.id == t.cat);
    final catName = catMatches.isNotEmpty
        ? catMatches.first.name
        : (t.department.isNotEmpty ? t.department : 'Routine Diagnostics');

    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: AppBar(
        title: Text(t.name, style: Mhn.t(16, w: FontWeight.w700, c: Mhn.ink)),
        backgroundColor: Colors.white,
        elevation: 0,
        centerTitle: false,
        iconTheme: const IconThemeData(color: Mhn.ink),
        actions: [
          IconButton(
            tooltip: 'View Cart',
            icon: Badge(
              isLabelVisible: ref.watch(mhnProvider.select((s) => s.cart.isNotEmpty)),
              label: Text('${ref.watch(mhnProvider.select((s) => s.cart.length))}'),
              child: const Icon(Icons.shopping_cart_outlined),
            ),
            onPressed: () => mhnPush<void>(context, const MhnCartScreen()),
          ),
          const SizedBox(width: 8),
        ],
      ),
      bottomNavigationBar: Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.08),
              blurRadius: 10,
              offset: const Offset(0, -3),
            ),
          ],
        ),
        child: SafeArea(
          top: false,
          child: Row(
            children: [
              Expanded(
                flex: 2,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Total Price', style: Mhn.t(11, c: Mhn.muted)),
                    const SizedBox(height: 1),
                    Text(
                      t.hasIndicativePrice ? rs(t.price) : 'Price on enquiry',
                      style: Mhn.t(18, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                flex: 3,
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: inCart ? const Color(0xFFC62828) : const Color(0xFF084D3B),
                    side: BorderSide(
                      color: inCart ? const Color(0xFFEF9A9A) : const Color(0xFF084D3B),
                      width: 1.5,
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  onPressed: () {
                    registerCartItem(MhnCartItem(
                      t.id,
                      t.name,
                      t.price,
                      '${t.fasting} · Report ${t.report}',
                      t.centre,
                    ));
                    ref.read(mhnProvider.notifier).toggleCart(t.id);
                  },
                  child: Text(
                    inCart ? 'Remove' : 'Add to Cart',
                    style: Mhn.t(13, w: FontWeight.w700),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 4,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF084D3B),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    elevation: 0,
                  ),
                  onPressed: () {
                    registerCartItem(MhnCartItem(
                      t.id,
                      t.name,
                      t.price,
                      '${t.fasting} · Report ${t.report}',
                      t.centre,
                    ));
                    if (!inCart) {
                      ref.read(mhnProvider.notifier).toggleCart(t.id);
                    }
                    mhnPush<void>(context, const MhnBookScreen());
                  },
                  child: Text(
                    'Book Now',
                    style: Mhn.t(14, w: FontWeight.w800, c: const Color(0xFFD9EE8C)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 1. Header Card
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: Mhn.line),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x06000000),
                  blurRadius: 10,
                  offset: Offset(0, 3),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE8F5E9),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          t.code.isNotEmpty ? '${t.code} · $catName' : catName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Mhn.t(11, w: FontWeight.w700, c: const Color(0xFF084D3B)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Icon(Icons.star, size: 16, color: Color(0xFFF9A825)),
                    const SizedBox(width: 4),
                    Text('4.8', style: Mhn.t(12, w: FontWeight.w700)),
                    Text(' (1,240+)', style: Mhn.t(11, c: Mhn.muted)),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  t.name,
                  style: Mhn.t(20, w: FontWeight.w800, c: Mhn.ink),
                ),
                const SizedBox(height: 6),
                Text(
                  t.desc.isNotEmpty ? t.desc : 'Diagnostic laboratory profile for comprehensive health assessment.',
                  style: Mhn.t(13, c: Mhn.mutedSoft, h: 1.4),
                ),
                const SizedBox(height: 14),
                const Divider(height: 1, color: Mhn.rowLine),
                const SizedBox(height: 14),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      t.hasIndicativePrice ? rs(t.price) : 'Price on enquiry',
                      style: Mhn.t(22, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                    ),
                    if (mrp > t.price) ...[
                      const SizedBox(width: 8),
                      Text(
                        rs(mrp),
                        style: Mhn.t(14, c: Mhn.muted, w: FontWeight.w500).copyWith(
                          decoration: TextDecoration.lineThrough,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFEBEE),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          '25% OFF',
                          style: Mhn.t(10, w: FontWeight.w800, c: const Color(0xFFC62828)),
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 2. Clinical Highlights Grid
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Mhn.line),
            ),
            child: Column(
              children: [
                _HighlightRow(
                  icon: Icons.fastfood_outlined,
                  iconColor: const Color(0xFFF57C00),
                  title: 'Fasting requirement',
                  value: t.fasting.isNotEmpty ? t.fasting : 'No fasting required',
                ),
                const Divider(height: 16, color: Mhn.rowLine),
                _HighlightRow(
                  icon: Icons.timer_outlined,
                  iconColor: const Color(0xFF1E88E5),
                  title: 'Report delivery',
                  value: t.reportingTime.isNotEmpty ? 'Report in ${t.reportingTime}' : (t.report.isNotEmpty ? 'Report ${t.report}' : 'Same day'),
                ),
                const Divider(height: 16, color: Mhn.rowLine),
                _HighlightRow(
                  icon: Icons.science_outlined,
                  iconColor: const Color(0xFF7B1FA2),
                  title: 'Sample & Container',
                  value: sampleType,
                ),
                if (t.method.isNotEmpty || t.department.isNotEmpty) ...[
                  const Divider(height: 16, color: Mhn.rowLine),
                  _HighlightRow(
                    icon: Icons.biotech_outlined,
                    iconColor: const Color(0xFF00897B),
                    title: 'Method & Department',
                    value: '${t.method.isNotEmpty ? t.method : 'Standard Assay'}${t.department.isNotEmpty ? ' · ${t.department}' : ''}',
                  ),
                ],
                if (t.tat.isNotEmpty && t.tat != t.reportingTime) ...[
                  const Divider(height: 16, color: Mhn.rowLine),
                  _HighlightRow(
                    icon: Icons.schedule_outlined,
                    iconColor: const Color(0xFF0D47A1),
                    title: 'Reporting Schedule (TAT)',
                    value: t.tat,
                  ),
                ],
                const Divider(height: 16, color: Mhn.rowLine),
                _HighlightRow(
                  icon: Icons.people_outline,
                  iconColor: const Color(0xFF5D4037),
                  title: 'Target age group',
                  value: t.age.isNotEmpty ? t.age : 'All age groups',
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 3. Parameters Tested (Biomarkers)
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Mhn.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => setState(() => _expandedParameters = !_expandedParameters),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      children: [
                        const Icon(Icons.biotech_outlined, color: Color(0xFF084D3B), size: 22),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'Parameters Tested (${params.length})',
                            style: Mhn.t(15, w: FontWeight.w700),
                          ),
                        ),
                        Icon(
                          _expandedParameters ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                          color: Mhn.muted,
                        ),
                      ],
                    ),
                  ),
                ),
                if (_expandedParameters) ...[
                  const Divider(height: 1, color: Mhn.rowLine),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (var i = 0; i < params.length; i++)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: Row(
                              children: [
                                const Icon(Icons.check_circle_outline, color: Color(0xFF2E7D32), size: 16),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    params[i],
                                    style: Mhn.t(13, w: FontWeight.w600, c: Mhn.ink),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 4. Test Preparation & Guidelines
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Mhn.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.assignment_outlined, color: Color(0xFF084D3B), size: 22),
                    const SizedBox(width: 10),
                    Text('Preparation & Guidelines', style: Mhn.t(15, w: FontWeight.w700)),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  t.needsFasting
                      ? '• Overnight fasting (10 to 12 hours) is mandatory prior to blood draw.\n• Drinking plain water in moderate amounts is allowed.\n• Avoid alcoholic beverages and heavy exercise 24 hours prior.\n• Take your regular prescription medicines unless advised otherwise by your doctor.'
                      : '• No fasting required for this test. You can eat and drink normally.\n• Stay hydrated by drinking normal amounts of water.\n• Inform our phlebotomist if you are taking any regular medications or supplements.',
                  style: Mhn.t(12.5, c: Mhn.mutedSoft, h: 1.5),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // 5. MetroLabs Quality Assurance
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFF3F9EE),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFD3E7C9)),
            ),
            child: Row(
              children: [
                const Icon(Icons.verified_outlined, color: Color(0xFF2E7D32), size: 28),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '100% Barcoded & NPHL Certified',
                        style: Mhn.t(13, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Every sample is tracked with bidirectional barcode analyzers and verified by certified senior pathologists.',
                        style: Mhn.t(11.5, c: const Color(0xFF2E6B4F), h: 1.3),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _HighlightRow extends StatelessWidget {
  const _HighlightRow({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.value,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: iconColor.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: iconColor, size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Mhn.t(11, c: Mhn.muted)),
              const SizedBox(height: 2),
              Text(value, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.ink)),
            ],
          ),
        ),
      ],
    );
  }
}
