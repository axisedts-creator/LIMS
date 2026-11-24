// Call / Call to Book bottom sheet & screen
// Supports direct hotline calling, WhatsApp advisor chat, and request callback.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'mhn_catalog_provider.dart';
import 'mhn_theme.dart';

class MhnCallSheet extends ConsumerWidget {
  const MhnCallSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet<void>(
        context: context,
        backgroundColor: Colors.transparent,
        isScrollControlled: true,
        builder: (_) => const MhnCallSheet(),
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final catalog = ref.watch(mhnCatalogProvider);
    final phone = catalog.supportPhone.isNotEmpty ? catalog.supportPhone : '+977-1-5000000';
    final dialDigits = phone.replaceAll(RegExp(r'[^\d+]'), '');
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
      decoration: const BoxDecoration(
        color: Mhn.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 44,
                height: 4,
                margin: const EdgeInsets.only(bottom: 18),
                decoration: BoxDecoration(
                  color: Mhn.lineStrong,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Row(
              children: [
                const MhnAvatar(name: 'Doctor', radius: 26),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Talk to a Health Advisor', style: Mhn.t(17, w: FontWeight.w700)),
                      Text(
                        'Available 7:00 AM - 8:00 PM (NPT)',
                        style: Mhn.t(12, c: Mhn.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            _CallOptionTile(
              icon: Icons.phone_in_talk,
              title: 'Call to Book Now',
              subtitle: '$phone (Lab Support & Booking)',
              color: Mhn.green,
              onTap: () async {
                final uri = Uri.parse('tel:$dialDigits');
                if (await canLaunchUrl(uri)) {
                  await launchUrl(uri);
                } else {
                  if (context.mounted) mhnToast(context, 'Dialing $phone');
                }
              },
            ),
            const SizedBox(height: 10),
            _CallOptionTile(
              icon: Icons.chat_bubble_outline,
              title: 'Chat with Health Advisor',
              subtitle: 'Quick answers about tests, preparation and packages',
              color: const Color(0xFF25D366),
              onTap: () {
                Navigator.of(context).pop();
                mhnToast(context, 'Connecting to WhatsApp health advisor ($phone)...');
              },
            ),
            const SizedBox(height: 10),
            _CallOptionTile(
              icon: Icons.support_agent,
              title: 'Request a Callback',
              subtitle: 'We will call you back within 10 minutes',
              color: const Color(0xFF1976D2),
              onTap: () {
                Navigator.of(context).pop();
                mhnToast(context, 'Callback request received. Our advisor will call you shortly.');
              },
            ),
            const SizedBox(height: 18),
            MhnButton(
              label: 'Close',
              secondary: true,
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }
}

class _CallOptionTile extends StatelessWidget {
  const _CallOptionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Mhn.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Mhn.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 24),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Mhn.t(14, w: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(subtitle, style: Mhn.t(11, c: Mhn.muted)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, size: 20, color: Mhn.mutedSoft),
            ],
          ),
        ),
      ),
    );
  }
}
