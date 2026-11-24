// MetroLabs AI Health Score & Clinical Intelligence Screen
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'test_detail_screen.dart';

class MhnAiHealthScoreScreen extends ConsumerStatefulWidget {
  const MhnAiHealthScoreScreen({super.key});

  @override
  ConsumerState<MhnAiHealthScoreScreen> createState() => _MhnAiHealthScoreScreenState();
}

class _MhnAiHealthScoreScreenState extends ConsumerState<MhnAiHealthScoreScreen> {
  final _aiQuestionCtrl = TextEditingController();
  final List<Map<String, String>> _chatMessages = [];
  bool _thinking = false;

  @override
  void dispose() {
    _aiQuestionCtrl.dispose();
    super.dispose();
  }

  void _askAi(String question) {
    if (question.trim().isEmpty) return;
    setState(() {
      _chatMessages.add({'role': 'user', 'text': question});
      _thinking = true;
      _aiQuestionCtrl.clear();
    });

    Future.delayed(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      final q = question.toLowerCase();
      String response = '';
      if (q.contains('score') || q.contains('improve')) {
        response =
            'To boost your Health Score from 72 to 85+:\n1. Increase daily steps by ~2,500 steps to reach the 8,500 active zone.\n2. Hydrate with at least 8 glasses (2 L) of water daily.\n3. Schedule a preventive Lipid Profile and Vitamin D3 panel within 4 weeks.';
      } else if (q.contains('diabeat') || q.contains('sugar')) {
        response =
            'Your fasting blood glucose is 95 mg/dL (Normal). Diabeat-Ease™ is a natural botanical formulation containing Gurmar and Vijaysar that supports healthy insulin sensitivity and metabolic stability.';
      } else if (q.contains('pressure') || q.contains('bp')) {
        response =
            'Your recorded blood pressure is 120/80 mmHg. This falls strictly into the Optimal American Heart Association (AHA) category. Maintain sodium intake below 2,300 mg daily.';
      } else if (q.contains('test') || q.contains('recommend') || q.contains('checkup')) {
        response =
            'Based on your demographic and activity profile, MetroLabs recommends: Complete Blood Count (CBC) and Lipid Profile every 6-12 months for routine preventive screening.';
      } else {
        response =
            'MetroLabs AI Analysis: Your biomarkers indicate healthy metabolic and organ baseline. Continue balanced nutrition, consistent hydration, and active daily steps.';
      }

      setState(() {
        _thinking = false;
        _chatMessages.add({'role': 'ai', 'text': response});
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);

    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: AppBar(
        title: Row(
          children: [
            const Icon(Icons.auto_awesome, color: Color(0xFF8BB535), size: 20),
            const SizedBox(width: 8),
            Text('AI Health Score & Insights', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.ink)),
          ],
        ),
        backgroundColor: Colors.white,
        elevation: 0,
        centerTitle: false,
        iconTheme: const IconThemeData(color: Mhn.ink),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 1. AI Score Header Card
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF084D3B), Color(0xFF0F6D54)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(22),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x1F000000),
                  blurRadius: 14,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFD9EE8C),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.bolt, size: 14, color: Color(0xFF084D3B)),
                          const SizedBox(width: 4),
                          Text(
                            'METROLABS HEALTH AI',
                            style: Mhn.t(10.5, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      'Updated Today',
                      style: Mhn.t(11, c: Colors.white70),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    Stack(
                      alignment: Alignment.center,
                      children: [
                        SizedBox(
                          width: 100,
                          height: 100,
                          child: CircularProgressIndicator(
                            value: st.healthKarmaScore / 100,
                            strokeWidth: 9,
                            backgroundColor: Colors.white12,
                            valueColor: const AlwaysStoppedAnimation<Color>(Color(0xFFD9EE8C)),
                          ),
                        ),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              '${st.healthKarmaScore}',
                              style: Mhn.t(32, w: FontWeight.w800, c: Colors.white),
                            ),
                            Text(
                              '/ 100',
                              style: Mhn.t(11, c: Colors.white70),
                            ),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(width: 20),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFF8BB535),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              'GOOD HEALTH STATUS',
                              style: Mhn.t(10, w: FontWeight.w800, c: Colors.white),
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Top 35% of age group',
                            style: Mhn.t(15, w: FontWeight.w700, c: Colors.white),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Organ biomarkers normal. Activity & hydration can boost score to 85+.',
                            style: Mhn.t(11.5, c: Colors.white.withValues(alpha: 0.85), h: 1.3),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // 2. AI Organ & Biomarker Breakdown
          Text('Biomarker & Clinical Breakdown', style: Mhn.t(15, w: FontWeight.w800)),
          const SizedBox(height: 10),
          _BiomarkerProgressRow(
            label: 'Metabolic & Sugar (FBS: ${st.bloodSugar} mg/dL)',
            score: 88,
            status: 'Optimal',
            statusColor: const Color(0xFF2E7D32),
          ),
          const SizedBox(height: 8),
          _BiomarkerProgressRow(
            label: 'Cardiovascular (BP: ${st.bloodPressure}, HR: ${st.heartRateBpm})',
            score: 82,
            status: 'Low Risk',
            statusColor: const Color(0xFF1565C0),
          ),
          const SizedBox(height: 8),
          _BiomarkerProgressRow(
            label: 'Vital Organs (Liver & Kidney Health)',
            score: 92,
            status: 'Excellent',
            statusColor: const Color(0xFF00695C),
          ),
          const SizedBox(height: 8),
          _BiomarkerProgressRow(
            label: 'Activity & Movement (${st.stepCount} steps today)',
            score: 64,
            status: 'Moderate',
            statusColor: const Color(0xFFE65100),
          ),
          const SizedBox(height: 20),

          // 3. AI Recommendations
          Container(
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
                    const Icon(Icons.lightbulb_outline, color: Color(0xFFF57C00), size: 22),
                    const SizedBox(width: 8),
                    Text('AI Clinical Action Plan', style: Mhn.t(15, w: FontWeight.w800)),
                  ],
                ),
                const SizedBox(height: 12),
                _ActionItem(
                  icon: Icons.directions_walk,
                  title: 'Increase Daily Step Target',
                  subtitle: 'Walk 2,500 more steps in the evening to reach 8,500 steps/day.',
                ),
                const SizedBox(height: 10),
                _ActionItem(
                  icon: Icons.water_drop_outlined,
                  title: 'Hydration Target',
                  subtitle: 'Drink 3 additional glasses of water spaced before 7:00 PM.',
                ),
                const SizedBox(height: 10),
                _ActionItem(
                  icon: Icons.medical_services_outlined,
                  title: 'Recommended Lab Screen',
                  subtitle: 'Annual Complete Blood Count (CBC) and Lipid Profile due in 3 months.',
                  onAction: () {
                    final cbc = kTests.firstWhere((t) => t.id == 'cbc');
                    mhnPush<void>(context, MhnTestDetailScreen(test: cbc));
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // 4. Interactive Ask Health AI
          Container(
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
                    const Icon(Icons.chat_bubble_outline, color: Color(0xFF084D3B), size: 20),
                    const SizedBox(width: 8),
                    Text('Ask MetroLabs Health AI', style: Mhn.t(15, w: FontWeight.w800)),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  'Have questions about your health score or lab values? Ask below:',
                  style: Mhn.t(12, c: Mhn.mutedSoft),
                ),
                const SizedBox(height: 12),
                // Quick suggested question chips
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      ActionChip(
                        label: Text('How to reach 85+ score?', style: Mhn.t(11, w: FontWeight.w700, c: const Color(0xFF084D3B))),
                        backgroundColor: const Color(0xFFF3F9EE),
                        onPressed: () => _askAi('How can I improve my health score to 85+?'),
                      ),
                      const SizedBox(width: 8),
                      ActionChip(
                        label: Text('Is my BP 120/80 normal?', style: Mhn.t(11, w: FontWeight.w700, c: const Color(0xFF084D3B))),
                        backgroundColor: const Color(0xFFF3F9EE),
                        onPressed: () => _askAi('Is my blood pressure 120/80 normal?'),
                      ),
                      const SizedBox(width: 8),
                      ActionChip(
                        label: Text('Recommend checkup', style: Mhn.t(11, w: FontWeight.w700, c: const Color(0xFF084D3B))),
                        backgroundColor: const Color(0xFFF3F9EE),
                        onPressed: () => _askAi('What test should I book next?'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                if (_chatMessages.isNotEmpty) ...[
                  for (final msg in _chatMessages)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: msg['role'] == 'user' ? const Color(0xFFF5F5F5) : const Color(0xFFF3F9EE),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: msg['role'] == 'user' ? Mhn.line : const Color(0xFFD3E7C9),
                          ),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(
                              msg['role'] == 'user' ? Icons.person_outline : Icons.auto_awesome,
                              size: 16,
                              color: msg['role'] == 'user' ? Mhn.muted : const Color(0xFF084D3B),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                msg['text'] ?? '',
                                style: Mhn.t(12.5, c: Mhn.ink, h: 1.35),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
                if (_thinking)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF084D3B)),
                      ),
                    ),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _aiQuestionCtrl,
                        decoration: InputDecoration(
                          hintText: 'Type health query...',
                          hintStyle: Mhn.t(12, c: Mhn.muted),
                          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                          filled: true,
                          fillColor: const Color(0xFFF8F9FA),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: const BorderSide(color: Mhn.line),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: const BorderSide(color: Mhn.line),
                          ),
                        ),
                        onSubmitted: _askAi,
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      icon: const Icon(Icons.send, color: Color(0xFF084D3B)),
                      onPressed: () => _askAi(_aiQuestionCtrl.text),
                    ),
                  ],
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

class _BiomarkerProgressRow extends StatelessWidget {
  const _BiomarkerProgressRow({
    required this.label,
    required this.score,
    required this.status,
    required this.statusColor,
  });

  final String label;
  final int score;
  final String status;
  final Color statusColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Mhn.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(label, style: Mhn.t(12.5, w: FontWeight.w700, c: Mhn.ink)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  status,
                  style: Mhn.t(10, w: FontWeight.w800, c: statusColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: score / 100,
              minHeight: 6,
              backgroundColor: const Color(0xFFEEEEEE),
              valueColor: AlwaysStoppedAnimation<Color>(statusColor),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionItem extends StatelessWidget {
  const _ActionItem({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onAction,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                color: const Color(0xFFF3F9EE),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, color: const Color(0xFF2E7D32), size: 18),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.ink)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: Mhn.t(11.5, c: Mhn.mutedSoft, h: 1.3)),
                  if (onAction != null) ...[
                    const SizedBox(height: 4),
                    Text('View & Book Test >', style: Mhn.t(11.5, w: FontWeight.w800, c: const Color(0xFF084D3B))),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
