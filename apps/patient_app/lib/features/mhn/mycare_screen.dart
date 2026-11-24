// H07: MyCare Screen (HealthKarma, Consults, Diet Plan, Samsung Health style Daily Tracker, Supplements)
// Wireframe pages 16-17 with 3D gauge, AI health score, realistic portraits, and Samsung Health daily activity tracker.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ai_health_score_screen.dart';
import 'herb_screen.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMyCareScreen extends ConsumerWidget {
  const MhnMyCareScreen({super.key});

  void _showLogSheet({
    required BuildContext context,
    required WidgetRef ref,
    required String title,
    required String initialValue,
    required String unit,
    required void Function(String) onSave,
  }) {
    final ctrl = TextEditingController(text: initialValue);
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: Container(
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
              Text('Log $title', style: Mhn.t(18, w: FontWeight.w800, c: Mhn.ink)),
              const SizedBox(height: 6),
              Text('Enter your latest measurement for today.', style: Mhn.t(12, c: Mhn.mutedSoft)),
              const SizedBox(height: 16),
              TextField(
                controller: ctrl,
                autofocus: true,
                keyboardType: TextInputType.text,
                decoration: InputDecoration(
                  labelText: '$title ($unit)',
                  filled: true,
                  fillColor: const Color(0xFFF8F9FA),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                ),
              ),
              const SizedBox(height: 18),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF084D3B),
                    foregroundColor: const Color(0xFFD9EE8C),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    elevation: 0,
                  ),
                  onPressed: () {
                    final val = ctrl.text.trim();
                    if (val.isNotEmpty) {
                      onSave(val);
                      Navigator.pop(ctx);
                      mhnToast(context, '$title updated to $val $unit');
                    }
                  },
                  child: Text('Save Measurement', style: Mhn.t(14, w: FontWeight.w800)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(mhnProvider);
    final first = st.profile.name.split(' ').first;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        // Greeting Header
        Row(
          children: [
            MhnAvatar(
              name: st.profile.name,
              radius: 22,
              borderColor: Mhn.green,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text('Hi, $first', style: Mhn.t(17, w: FontWeight.w700)),
                      const SizedBox(width: 4),
                      const Icon(Icons.keyboard_arrow_down, size: 18, color: Mhn.muted),
                    ],
                  ),
                  Text('Track your daily activity & stay healthy', style: Mhn.t(12, c: Mhn.muted)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // HealthKarma 3D Card
        Mhn3DTiltCard(
          onTap: () => mhnPush<void>(context, const MhnAiHealthScoreScreen()),
          child: Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0xFF0E4B3B), Color(0xFF1B6B52), Color(0xFF639E28)],
              ),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x280E4B3B),
                  blurRadius: 18,
                  offset: Offset(0, 8),
                ),
              ],
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFFD9EE8C),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Row(
                              children: [
                                const Icon(Icons.auto_awesome, size: 11, color: Color(0xFF084D3B)),
                                const SizedBox(width: 3),
                                Text(
                                  'AI POWERED',
                                  style: Mhn.t(9, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'HealthKarma™',
                        style: Mhn.t(22, w: FontWeight.w800, c: const Color(0xFFD9EE8C)),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'AI-analyzed clinical health score from your lab panels.',
                        style: Mhn.t(12, c: Colors.white.withValues(alpha: 0.9), h: 1.3),
                      ),
                      const SizedBox(height: 12),
                      Material(
                        color: const Color(0xFF8BB535),
                        borderRadius: BorderRadius.circular(10),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(10),
                          onTap: () => mhnPush<void>(context, const MhnAiHealthScoreScreen()),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.auto_awesome, size: 14, color: Colors.white),
                                const SizedBox(width: 6),
                                Text(
                                  'View Health Score',
                                  style: Mhn.t(12, w: FontWeight.w700, c: Mhn.white),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                InkWell(
                  onTap: () => mhnPush<void>(context, const MhnAiHealthScoreScreen()),
                  borderRadius: BorderRadius.circular(52),
                  child: Mhn3DHealthScoreGauge(score: st.healthKarmaScore, size: 104),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),

        // Consult Doctor & Consult Dietitian
        Row(
          children: [
            Expanded(
              child: MhnCard(
                padding: const EdgeInsets.all(14),
                child: Column(
                  children: [
                    const MhnAvatar(
                      name: 'Doctor',
                      radius: 28,
                      borderColor: Color(0xFFDCE8E0),
                    ),
                    const SizedBox(height: 10),
                    Text('Consult Doctor', style: Mhn.t(14, w: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text('Verified Clinicians', style: Mhn.t(11, c: Mhn.mutedSoft)),
                    const SizedBox(height: 12),
                    MhnButton(
                      label: 'Consult Now',
                      gradient: false,
                      onPressed: () => mhnToast(context, 'Doctor teleconsultation opens shortly.'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: MhnCard(
                padding: const EdgeInsets.all(14),
                child: Column(
                  children: [
                    const MhnAvatar(
                      name: 'Dietitian',
                      radius: 28,
                      borderColor: Color(0xFFDCE8E0),
                    ),
                    const SizedBox(height: 10),
                    Text('Consult Dietitian', style: Mhn.t(14, w: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text('Fee: MetroLabs to confirm', style: Mhn.t(11, c: Mhn.mutedSoft)),
                    const SizedBox(height: 12),
                    MhnButton(
                      label: 'Book Now',
                      lime: true,
                      onPressed: () => mhnToast(context, 'Dietitian booking opens shortly.'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // Free 7-days smart diet plan
        MhnCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: const Color(0xFFF3F9EE),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: const Center(
                  child: Icon(Icons.restaurant_menu, color: Color(0xFF6B9926), size: 34),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                'Free 7-days smart diet plan',
                style: Mhn.t(16, w: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(
                'Customized meal recommendations per your lab panel',
                textAlign: TextAlign.center,
                style: Mhn.t(12, c: Mhn.muted),
              ),
              const SizedBox(height: 14),
              MhnButton(
                label: 'Get Your Diet Plan',
                onPressed: () => mhnToast(context, '7-Day Diet Plan generated per latest CBC and Lipid Profile.'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),

        // Samsung Health Style Daily Health Tracker Section
        Row(
          children: [
            Text('Daily Health Tracker', style: Mhn.h2),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: const Color(0xFFE8F5E9),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                children: [
                  const Icon(Icons.favorite, size: 12, color: Color(0xFF2E7D32)),
                  const SizedBox(width: 4),
                  Text('Samsung Health style', style: Mhn.t(10.5, w: FontWeight.w700, c: const Color(0xFF2E7D32))),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),

        // 1. Samsung Health Daily Activity Card (Tri-metric Heart)
        _SamsungDailyActivityCard(
          steps: st.stepCount,
          activeMinutes: 45,
          calories: 395,
          onTap: () => _showLogSheet(
            context: context,
            ref: ref,
            title: 'Steps',
            initialValue: '${st.stepCount}',
            unit: 'steps',
            onSave: (v) {
              final n = int.tryParse(v);
              if (n != null) ref.read(mhnProvider.notifier).updateHealthTracker(steps: n);
            },
          ),
        ),
        const SizedBox(height: 12),

        // 2. Water Tracker Card with live + / - buttons
        _SamsungWaterCard(
          glasses: st.waterGlasses,
          target: 8,
          onAdd: () {
            ref.read(mhnProvider.notifier).updateHealthTracker(water: (st.waterGlasses + 1).clamp(0, 16));
          },
          onRemove: () {
            ref.read(mhnProvider.notifier).updateHealthTracker(water: (st.waterGlasses - 1).clamp(0, 16));
          },
        ),
        const SizedBox(height: 12),

        // 3. Sleep Tracker Card (Samsung Sleep Score 84)
        const _SamsungSleepCard(),
        const SizedBox(height: 12),

        // 4. Heart Rate & Blood Pressure Card (Vitals)
        Row(
          children: [
            Expanded(
              child: _SamsungMetricCard(
                icon: Icons.favorite,
                iconColor: const Color(0xFFE53935),
                title: 'Heart rate',
                value: '${st.heartRateBpm}',
                unit: 'bpm',
                subtitle: 'Resting · Normal',
                onTap: () => _showLogSheet(
                  context: context,
                  ref: ref,
                  title: 'Heart Rate',
                  initialValue: '${st.heartRateBpm}',
                  unit: 'bpm',
                  onSave: (v) {
                    final n = int.tryParse(v);
                    if (n != null) ref.read(mhnProvider.notifier).updateHealthTracker(hr: n);
                  },
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _SamsungMetricCard(
                icon: Icons.bloodtype_outlined,
                iconColor: const Color(0xFFC2185B),
                title: 'Blood pressure',
                value: st.bloodPressure,
                unit: 'mmHg',
                subtitle: 'Optimal range',
                onTap: () => _showLogSheet(
                  context: context,
                  ref: ref,
                  title: 'Blood Pressure',
                  initialValue: st.bloodPressure,
                  unit: 'mmHg',
                  onSave: (v) {
                    ref.read(mhnProvider.notifier).updateHealthTracker(bp: v);
                  },
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),

        // 5. Blood Sugar & Weight
        Row(
          children: [
            Expanded(
              child: _SamsungMetricCard(
                icon: Icons.water_drop,
                iconColor: const Color(0xFFFB8C00),
                title: 'Blood glucose',
                value: '${st.bloodSugar}',
                unit: 'mg/dL',
                subtitle: 'Fasting · Normal',
                onTap: () => _showLogSheet(
                  context: context,
                  ref: ref,
                  title: 'Blood Glucose',
                  initialValue: '${st.bloodSugar}',
                  unit: 'mg/dL',
                  onSave: (v) {
                    final n = int.tryParse(v);
                    if (n != null) ref.read(mhnProvider.notifier).updateHealthTracker(sugar: n);
                  },
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _SamsungMetricCard(
                icon: Icons.scale_outlined,
                iconColor: const Color(0xFF1E88E5),
                title: 'Weight',
                value: '${st.weightKg}',
                unit: 'kg',
                subtitle: 'BMI 22.4 · Healthy',
                onTap: () => _showLogSheet(
                  context: context,
                  ref: ref,
                  title: 'Weight',
                  initialValue: '${st.weightKg}',
                  unit: 'kg',
                  onSave: (v) {
                    final n = int.tryParse(v);
                    if (n != null) ref.read(mhnProvider.notifier).updateHealthTracker(weight: n);
                  },
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),

        // 3D Supplements Section
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Herbवेद+™ Supplements', style: Mhn.h2),
            InkWell(
              onTap: () => mhnPush<void>(context, const HerbSupplementsScreen()),
              child: Text('Explore now ›', style: Mhn.t(13, w: FontWeight.w700, c: Mhn.green)),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: MhnCard(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    const Mhn3DProductBox(
                      name: 'DIABEAT-EASE',
                      primaryColor: Color(0xFF1B6B52),
                    ),
                    const SizedBox(height: 10),
                    Text('Diabeat-Ease', style: Mhn.t(13, w: FontWeight.w700)),
                    Text('Rs. 1,035', style: Mhn.t(12, w: FontWeight.w800, c: Mhn.ink)),
                    const SizedBox(height: 8),
                    MhnButton(
                      label: 'VIEW',
                      lime: true,
                      onPressed: () => mhnPush<void>(context, const HerbSupplementsScreen()),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: MhnCard(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    const Mhn3DProductBox(
                      name: 'CALCI-BUILD',
                      primaryColor: Color(0xFF285E8C),
                    ),
                    const SizedBox(height: 10),
                    Text('Calci-Build', style: Mhn.t(13, w: FontWeight.w700)),
                    Text('Rs. 557', style: Mhn.t(12, w: FontWeight.w800, c: Mhn.ink)),
                    const SizedBox(height: 8),
                    MhnButton(
                      label: 'VIEW',
                      lime: true,
                      onPressed: () => mhnPush<void>(context, const HerbSupplementsScreen()),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),

        // Quality assurance note
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFFE8F4EC),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFC7E2D0)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.verified_outlined, size: 18, color: Mhn.green),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Daily health tracker syncs with your routine lab evaluations and Samsung Health compatible metrics.',
                  style: Mhn.t(11, c: Mhn.muted, h: 1.3),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Samsung Health iconic Daily Activity tri-metric card
class _SamsungDailyActivityCard extends StatelessWidget {
  const _SamsungDailyActivityCard({
    required this.steps,
    required this.activeMinutes,
    required this.calories,
    required this.onTap,
  });

  final int steps;
  final int activeMinutes;
  final int calories;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final stepProgress = (steps / 10000).clamp(0.0, 1.0);
    final activeProgress = (activeMinutes / 60).clamp(0.0, 1.0);
    final calProgress = (calories / 500).clamp(0.0, 1.0);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: Mhn.line),
          boxShadow: const [
            BoxShadow(
              color: Color(0x06000000),
              blurRadius: 8,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.favorite, color: Color(0xFF00C853), size: 18),
                const SizedBox(width: 8),
                Text('Daily activity', style: Mhn.t(15, w: FontWeight.w800, c: Mhn.ink)),
                const Spacer(),
                const Icon(Icons.chevron_right, size: 18, color: Mhn.muted),
              ],
            ),
            const SizedBox(height: 14),
            // Progress bars
            _ActivityBar(
              label: 'Steps',
              value: '$steps / 10,000',
              progress: stepProgress,
              color: const Color(0xFF00C853),
            ),
            const SizedBox(height: 10),
            _ActivityBar(
              label: 'Active time',
              value: '$activeMinutes / 60 mins',
              progress: activeProgress,
              color: const Color(0xFF00B0FF),
            ),
            const SizedBox(height: 10),
            _ActivityBar(
              label: 'Activity cal',
              value: '$calories / 500 kcal',
              progress: calProgress,
              color: const Color(0xFFFF5252),
            ),
            const SizedBox(height: 12),
            const Divider(height: 1, color: Mhn.rowLine),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('4.8 km walked', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.mutedSoft)),
                Text('$calories kcal burned', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.mutedSoft)),
                Text('$activeMinutes mins active', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.mutedSoft)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ActivityBar extends StatelessWidget {
  const _ActivityBar({
    required this.label,
    required this.value,
    required this.progress,
    required this.color,
  });

  final String label;
  final String value;
  final double progress;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.ink)),
            Text(value, style: Mhn.t(12, w: FontWeight.w700, c: color)),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: progress,
            minHeight: 7,
            backgroundColor: color.withValues(alpha: 0.15),
            valueColor: AlwaysStoppedAnimation<Color>(color),
          ),
        ),
      ],
    );
  }
}

/// Samsung Health Water Tracker Card with quick tap buttons
class _SamsungWaterCard extends StatelessWidget {
  const _SamsungWaterCard({
    required this.glasses,
    required this.target,
    required this.onAdd,
    required this.onRemove,
  });

  final int glasses;
  final int target;
  final VoidCallback onAdd;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Mhn.line),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: const Color(0xFFE1F5FE),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(Icons.water_drop, color: Color(0xFF0288D1), size: 26),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Water', style: Mhn.t(14, w: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(
                  '$glasses / $target glasses (${glasses * 250} ml)',
                  style: Mhn.t(12, c: const Color(0xFF0288D1), w: FontWeight.w700),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.remove_circle_outline, color: Color(0xFF0288D1), size: 26),
            onPressed: onRemove,
          ),
          IconButton(
            icon: const Icon(Icons.add_circle, color: Color(0xFF0288D1), size: 28),
            onPressed: onAdd,
          ),
        ],
      ),
    );
  }
}

/// Samsung Health Sleep Tracker Card
class _SamsungSleepCard extends StatelessWidget {
  const _SamsungSleepCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Mhn.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: const Color(0xFFEDE7F6),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.bedtime_outlined, color: Color(0xFF5E35B1), size: 20),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Sleep', style: Mhn.t(14, w: FontWeight.w800)),
                  Text('11:15 PM – 6:39 AM', style: Mhn.t(11, c: Mhn.muted)),
                ],
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFFEDE7F6),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text('Score 84 · Good', style: Mhn.t(11, w: FontWeight.w700, c: const Color(0xFF5E35B1))),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text('7h 24m', style: Mhn.t(22, w: FontWeight.w800, c: Mhn.ink)),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: Row(
              children: const [
                Expanded(flex: 25, child: SizedBox(height: 7, child: ColoredBox(color: Color(0xFF5E35B1)))),
                SizedBox(width: 2),
                Expanded(flex: 30, child: SizedBox(height: 7, child: ColoredBox(color: Color(0xFF7E57C2)))),
                SizedBox(width: 2),
                Expanded(flex: 45, child: SizedBox(height: 7, child: ColoredBox(color: Color(0xFFB39DDB)))),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Deep: 1h 45m · REM: 2h 10m · Light: 3h 29m',
            style: Mhn.t(11, c: Mhn.mutedSoft),
          ),
        ],
      ),
    );
  }
}

/// Samsung Health Compact Metric Card
class _SamsungMetricCard extends StatelessWidget {
  const _SamsungMetricCard({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.value,
    required this.unit,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String value;
  final String unit;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(14),
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
                Icon(icon, color: iconColor, size: 18),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    title,
                    style: Mhn.t(12.5, w: FontWeight.w700, c: Mhn.ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(value, style: Mhn.t(18, w: FontWeight.w800, c: Mhn.ink)),
                const SizedBox(width: 4),
                Text(unit, style: Mhn.t(11, c: Mhn.muted)),
              ],
            ),
            const SizedBox(height: 4),
            Text(subtitle, style: Mhn.t(10.5, c: Mhn.mutedSoft)),
          ],
        ),
      ),
    );
  }
}
