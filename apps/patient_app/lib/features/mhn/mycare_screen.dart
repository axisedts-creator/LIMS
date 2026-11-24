// H07: MyCare Screen (HealthKarma, Consults, Diet Plan, Daily Tracker, Supplements)
// Wireframe pages 16-17 with 3D gauge, realistic doctor/dietitian portraits, and daily health metrics.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMyCareScreen extends ConsumerWidget {
  const MhnMyCareScreen({super.key});

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
                      Text(
                        'Check your',
                        style: Mhn.t(14, w: FontWeight.w600, c: Colors.white70),
                      ),
                      Text(
                        'HealthKarma',
                        style: Mhn.t(22, w: FontWeight.w800, c: const Color(0xFFD9EE8C)),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Get your personalised health score in minutes.',
                        style: Mhn.t(12, c: Colors.white.withValues(alpha: 0.9), h: 1.3),
                      ),
                      const SizedBox(height: 14),
                      Material(
                        color: const Color(0xFF8BB535),
                        borderRadius: BorderRadius.circular(10),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(10),
                          onTap: () => mhnToast(context, 'HealthKarma score: ${st.healthKarmaScore} / 100 (Sample only)'),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            child: Text(
                              'View Health Score',
                              style: Mhn.t(12, w: FontWeight.w700, c: Mhn.white),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Mhn3DHealthScoreGauge(score: st.healthKarmaScore, size: 104),
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

        // Daily Health Tracker Section
        Text('Daily Health Tracker', style: Mhn.h2),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _MetricCard(
                icon: Icons.directions_walk,
                iconColor: const Color(0xFF388E3C),
                label: 'Step Count',
                value: '${st.stepCount} steps',
                onTap: () => mhnToast(context, 'Step Count today: ${st.stepCount} steps'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _MetricCard(
                icon: Icons.water_drop_outlined,
                iconColor: const Color(0xFFF57C00),
                label: 'Blood sugar',
                value: '${st.bloodSugar} mg/dL',
                onTap: () => mhnToast(context, 'Fasting Blood Sugar: ${st.bloodSugar} mg/dL (Normal)'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _MetricCard(
                icon: Icons.scale_outlined,
                iconColor: const Color(0xFF1976D2),
                label: 'Weight',
                value: '${st.weightKg} kg',
                onTap: () => mhnToast(context, 'Current Weight: ${st.weightKg} kg'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _MetricCard(
                icon: Icons.favorite_border,
                iconColor: const Color(0xFFD32F2F),
                label: 'Blood Pressure',
                value: st.bloodPressure,
                onTap: () => mhnToast(context, 'Blood Pressure: ${st.bloodPressure} mmHg (Optimal)'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _MetricCard(
                icon: Icons.monitor_heart_outlined,
                iconColor: const Color(0xFFE91E63),
                label: 'Heart Rate',
                value: '${st.heartRateBpm} bpm',
                onTap: () => mhnToast(context, 'Resting Heart Rate: ${st.heartRateBpm} bpm'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _MetricCard(
                icon: Icons.medication_outlined,
                iconColor: const Color(0xFF7B1FA2),
                label: 'Track Medicine',
                value: '2 due today',
                onTap: () => mhnToast(context, 'Morning medicines: 2 pending'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _MetricCard(
          icon: Icons.medical_services_outlined,
          iconColor: Mhn.green,
          label: 'My Doctor',
          value: 'Track consultations & follow-ups',
          onTap: () => mhnToast(context, 'No pending follow-ups this week.'),
        ),
        const SizedBox(height: 24),

        // 3D Supplements Section
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Supplements', style: Mhn.h2),
            InkWell(
              onTap: () => mhnToast(context, 'Supplements catalog opens.'),
              child: Text('Explore now â€º', style: Mhn.t(13, w: FontWeight.w700, c: Mhn.green)),
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
                    Text('Rs. 728', style: Mhn.t(12, w: FontWeight.w800, c: Mhn.ink)),
                    const SizedBox(height: 8),
                    MhnButton(
                      label: 'ADD',
                      lime: true,
                      onPressed: () => mhnToast(context, 'Added Diabeat-Ease to cart'),
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
                    Text('Rs. 1,035', style: Mhn.t(12, w: FontWeight.w800, c: Mhn.ink)),
                    const SizedBox(height: 8),
                    MhnButton(
                      label: 'ADD',
                      lime: true,
                      onPressed: () => mhnToast(context, 'Added Calci-Build to cart'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),

        // Sample Data Disclaimer Note per Wireframe Page 17
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
              const Icon(Icons.info_outline, size: 18, color: Mhn.green),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Phase 2. Needs clinicians and a data/privacy decision. Score, fee and products are samples.',
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

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.icon,
    required this.iconColor,
    required this.label,
    required this.value,
    required this.onTap,
  });

  final IconData icon;
  final Color iconColor;
  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return MhnCard(
      padding: const EdgeInsets.all(12),
      child: InkWell(
        onTap: onTap,
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: iconColor, size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: Mhn.t(12, w: FontWeight.w600)),
                  Text(value, style: Mhn.t(11, c: Mhn.muted)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 16, color: Mhn.mutedSoft),
          ],
        ),
      ),
    );
  }
}
