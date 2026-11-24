// Herbवेद+™ Ayurvedic & Natural Wellness supplements catalog screen.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_theme.dart';

class MhnSupplementItem {
  const MhnSupplementItem({
    required this.id,
    required this.name,
    required this.subtitle,
    required this.price,
    required this.mrp,
    required this.discount,
    required this.category,
    required this.ingredients,
    required this.dosage,
    required this.iconColor,
  });

  final String id;
  final String name;
  final String subtitle;
  final int price;
  final int mrp;
  final String discount;
  final String category;
  final String ingredients;
  final String dosage;
  final Color iconColor;
}

const kHerbSupplements = <MhnSupplementItem>[
  MhnSupplementItem(
    id: 'diabeat',
    name: 'DIABEAT-EASE™',
    subtitle: 'Advanced Blood Sugar & HbA1c Metabolic Care',
    price: 1035,
    mrp: 2300,
    discount: '55% OFF',
    category: 'Sugar',
    ingredients: 'Gurmar (Gymnema Sylvestre), Jamun, Karela, Vijaysar, Methi',
    dosage: '1 tablet twice daily 30 mins before meals',
    iconColor: Color(0xFF2E7D32),
  ),
  MhnSupplementItem(
    id: 'calci',
    name: 'CALCI BUILD™',
    subtitle: 'Bone Density, Joint Cartilage & Calcium Fortifier',
    price: 557,
    mrp: 1238,
    discount: '55% OFF',
    category: 'Bones',
    ingredients: 'Hadjod (Cissus quadrangularis), Moringa, Kukkutandatvak Bhasma, Vitamin D3',
    dosage: '1 tablet once daily with warm milk/water',
    iconColor: Color(0xFF00695C),
  ),
  MhnSupplementItem(
    id: 'cholest',
    name: 'CHOLEST-GUARD™',
    subtitle: 'Lipid Balance, Arterial Health & Healthy Circulation',
    price: 899,
    mrp: 1635,
    discount: '45% OFF',
    category: 'Heart',
    ingredients: 'Arjuna Bark, Shuddha Guggulu, Lasuna (Garlic), Pushkarmool',
    dosage: '1 tablet twice daily after meals',
    iconColor: Color(0xFF1565C0),
  ),
  MhnSupplementItem(
    id: 'ashwa',
    name: 'ASHWAGANDHA GOLD™',
    subtitle: 'Stress Relief, Vitality & Restful Sleep',
    price: 750,
    mrp: 1500,
    discount: '50% OFF',
    category: 'Stress',
    ingredients: 'Standardized KSM-66 Ashwagandha with 5% Withanolides',
    dosage: '1 tablet at bedtime with warm water',
    iconColor: Color(0xFF6A1B9A),
  ),
  MhnSupplementItem(
    id: 'liver',
    name: 'LIVER DETOX FORTE™',
    subtitle: 'Hepatic Protection & Fatty Liver Defense',
    price: 850,
    mrp: 1700,
    discount: '50% OFF',
    category: 'Liver',
    ingredients: 'Bhumi Amla, Kalmegh, Kutki, Punarnava, Milk Thistle extract',
    dosage: '1 tablet twice daily with water',
    iconColor: Color(0xFFE65100),
  ),
  MhnSupplementItem(
    id: 'immunity',
    name: 'IMMUNITY SHIELD PRO™',
    subtitle: 'Antioxidant & Seasonal Defense Formula',
    price: 620,
    mrp: 1240,
    discount: '50% OFF',
    category: 'Immunity',
    ingredients: 'Giloy, Tulsi, Amla, Curcumin 95%, Black Pepper extract',
    dosage: '1 tablet in the morning after breakfast',
    iconColor: Color(0xFFC2185B),
  ),
];

class HerbSupplementsScreen extends ConsumerStatefulWidget {
  const HerbSupplementsScreen({super.key});

  @override
  ConsumerState<HerbSupplementsScreen> createState() => _HerbSupplementsScreenState();
}

class _HerbSupplementsScreenState extends ConsumerState<HerbSupplementsScreen> {
  String _selectedCategory = 'All';

  static const _categories = ['All', 'Sugar', 'Bones', 'Heart', 'Stress', 'Liver', 'Immunity'];

  void _showOrderSheet(MhnSupplementItem item) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Container(
                  width: 50,
                  height: 50,
                  decoration: BoxDecoration(
                    color: item.iconColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(Icons.medication_liquid_outlined, color: item.iconColor, size: 30),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.name, style: Mhn.t(16, w: FontWeight.w800, c: Mhn.ink)),
                      Text(item.subtitle, style: Mhn.t(12, c: Mhn.mutedSoft), maxLines: 1),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Divider(height: 1, color: Mhn.rowLine),
            const SizedBox(height: 14),
            Text('Key Herbal Extracts:', style: Mhn.t(12.5, w: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(item.ingredients, style: Mhn.t(12, c: Mhn.mutedSoft)),
            const SizedBox(height: 10),
            Text('Recommended Dosage:', style: Mhn.t(12.5, w: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(item.dosage, style: Mhn.t(12, c: Mhn.mutedSoft)),
            const SizedBox(height: 16),
            Row(
              children: [
                Text(rs(item.price), style: Mhn.t(20, w: FontWeight.w800, c: const Color(0xFF084D3B))),
                const SizedBox(width: 8),
                Text(
                  rs(item.mrp),
                  style: Mhn.t(13, c: Mhn.muted).copyWith(decoration: TextDecoration.lineThrough),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFEBEE),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(item.discount, style: Mhn.t(10, w: FontWeight.w800, c: const Color(0xFFC62828))),
                ),
              ],
            ),
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFF084D3B),
                      side: const BorderSide(color: Color(0xFF084D3B)),
                      padding: const EdgeInsets.symmetric(vertical: 13),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onPressed: () {
                      Navigator.pop(ctx);
                      mhnToast(context, 'MetroLabs advisor will call you to confirm dosage.');
                    },
                    child: Text('Consult Advisor', style: Mhn.t(13, w: FontWeight.w700)),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF084D3B),
                      foregroundColor: const Color(0xFFD9EE8C),
                      padding: const EdgeInsets.symmetric(vertical: 13),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      elevation: 0,
                    ),
                    onPressed: () {
                      Navigator.pop(ctx);
                      mhnToast(context, '${item.name} added to your home delivery order.');
                    },
                    child: Text('Add to Order', style: Mhn.t(13, w: FontWeight.w800)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _selectedCategory == 'All'
        ? kHerbSupplements
        : kHerbSupplements.where((s) => s.category == _selectedCategory).toList();

    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: AppBar(
        title: Text('Herbवेद+™ Supplements', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.ink)),
        backgroundColor: Colors.white,
        elevation: 0,
        centerTitle: false,
        iconTheme: const IconThemeData(color: Mhn.ink),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Banner
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF084D3B), Color(0xFF0A664F)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFD9EE8C),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          '100% HERBAL & CERTIFIED',
                          style: Mhn.t(9.5, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Clinically Crafted Herbal Wellness',
                        style: Mhn.t(16, w: FontWeight.w800, c: Colors.white, h: 1.2),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Pure botanical extracts to complement your lab checkups.',
                        style: Mhn.t(11.5, c: Colors.white70),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: Colors.white12,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: const Icon(Icons.eco, color: Color(0xFFD9EE8C), size: 36),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Categories
          SizedBox(
            height: 38,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _categories.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (_, i) {
                final cat = _categories[i];
                final selected = cat == _selectedCategory;
                return ChoiceChip(
                  label: Text(cat, style: Mhn.t(12, w: selected ? FontWeight.w700 : FontWeight.w500, c: selected ? Colors.white : Mhn.ink)),
                  selected: selected,
                  selectedColor: const Color(0xFF084D3B),
                  backgroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                    side: BorderSide(color: selected ? const Color(0xFF084D3B) : Mhn.line),
                  ),
                  onSelected: (val) {
                    if (val) setState(() => _selectedCategory = cat);
                  },
                );
              },
            ),
          ),
          const SizedBox(height: 16),

          // Products List
          for (final item in filtered)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Mhn.line),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 50,
                      height: 50,
                      decoration: BoxDecoration(
                        color: item.iconColor.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Icon(Icons.medication_liquid_outlined, color: item.iconColor, size: 28),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(item.name, style: Mhn.t(14, w: FontWeight.w800, c: Mhn.ink)),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFFFEBEE),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(item.discount, style: Mhn.t(9.5, w: FontWeight.w800, c: const Color(0xFFC62828))),
                              ),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(item.subtitle, style: Mhn.t(11.5, c: Mhn.mutedSoft), maxLines: 2),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Text(rs(item.price), style: Mhn.t(15, w: FontWeight.w800, c: const Color(0xFF084D3B))),
                              const SizedBox(width: 6),
                              Text(
                                rs(item.mrp),
                                style: Mhn.t(12, c: Mhn.muted).copyWith(decoration: TextDecoration.lineThrough),
                              ),
                              const Spacer(),
                              ElevatedButton(
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF084D3B),
                                  foregroundColor: const Color(0xFFD9EE8C),
                                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                  minimumSize: Size.zero,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                  elevation: 0,
                                ),
                                onPressed: () => _showOrderSheet(item),
                                child: Text('Order', style: Mhn.t(12, w: FontWeight.w800)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
