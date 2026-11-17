// Contact tab: call / WhatsApp / email, address card with map, searchable FAQ accordion. Numbers and hours are placeholders to be confirmed.
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'mhn_data.dart';
import 'mhn_theme.dart';

class MhnContactTab extends StatefulWidget {
  const MhnContactTab({super.key});

  @override
  State<MhnContactTab> createState() => _MhnContactTabState();
}

class _MhnContactTabState extends State<MhnContactTab> {
  final _q = TextEditingController();
  int _open = -1;

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _maps() async {
    try {
      await launchUrl(Uri.parse('https://www.openstreetmap.org/search?query=Baneshwor%2C%20Kathmandu'), mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) mhnToast(context, 'Could not open Maps');
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.text.trim().toLowerCase();
    final faqs = [
      for (var i = 0; i < kFaqs.length; i++)
        if (q.isEmpty || '${kFaqs[i].q} ${kFaqs[i].a}'.toLowerCase().contains(q)) i,
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        Text('Contact us', style: Mhn.h1),
        const SizedBox(height: 4),
        Text('Talk to our team about bookings, reports or home collection.', style: Mhn.body),
        const SizedBox(height: 14),
        Row(children: [
          Expanded(child: _Action(icon: Icons.phone_outlined, label: 'Call', primary: true, onTap: () => mhnToast(context, 'Calls Metro Labs: [phone number to confirm]'))),
          const SizedBox(width: 10),
          Expanded(child: _Action(icon: Icons.chat_bubble_outline, label: 'WhatsApp', onTap: () => mhnToast(context, 'Opens WhatsApp chat: [number to confirm]'))),
          const SizedBox(width: 10),
          Expanded(child: _Action(icon: Icons.mail_outline, label: 'Email', onTap: () => mhnToast(context, 'Opens email to [address to confirm]'))),
        ]),
        const SizedBox(height: 22),
        Text('Our address', style: Mhn.h2),
        const SizedBox(height: 10),
        MhnCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            ClipRRect(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(Mhn.rCard)),
              child: const SizedBox(height: 118, width: double.infinity, child: CustomPaint(painter: _MapPainter())),
            ),
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Metro Labs, Baneshwor', style: Mhn.t(16, w: FontWeight.w800)),
                const SizedBox(height: 2),
                Text('[Street address], Baneshwor, Kathmandu', style: Mhn.t(13, c: Mhn.muted)),
                Text('Open [opening hours to confirm]', style: Mhn.t(13, c: Mhn.muted)),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  height: 44,
                  child: Material(
                    color: Mhn.tint,
                    borderRadius: BorderRadius.circular(12),
                    child: InkWell(borderRadius: BorderRadius.circular(12), onTap: _maps, child: Center(child: Text('Open in Maps', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green)))),
                  ),
                ),
              ]),
            ),
          ]),
        ),
        const SizedBox(height: 22),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(child: Text('Frequently asked questions', style: Mhn.t(19, w: FontWeight.w800))),
        ]),
        const SizedBox(height: 2),
        Text('${kFaqs.length} answers to common questions', style: Mhn.body),
        const SizedBox(height: 12),
        Container(
          height: 50,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(color: Mhn.white, borderRadius: BorderRadius.circular(Mhn.rField), border: Border.all(color: Mhn.line)),
          child: Row(children: [
            const Icon(Icons.search, size: 20, color: Mhn.green),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                controller: _q,
                onChanged: (_) => setState(() => _open = -1),
                style: Mhn.t(15, w: FontWeight.w600),
                decoration: InputDecoration(border: InputBorder.none, isCollapsed: true, hintText: 'Search questions', hintStyle: Mhn.t(15, c: Mhn.muted)),
              ),
            ),
          ]),
        ),
        const SizedBox(height: 12),
        if (faqs.isEmpty)
          MhnCard(
            child: Column(children: [
              Text('No questions match “${_q.text.trim()}”', textAlign: TextAlign.center, style: Mhn.t(15, w: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('Try another word, or ask us directly.', style: Mhn.body),
              const SizedBox(height: 12),
              _Action(icon: Icons.phone_outlined, label: 'Call us', primary: true, onTap: () => mhnToast(context, 'Calls Metro Labs: [phone number to confirm]')),
            ]),
          )
        else
          for (final i in faqs)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: MhnCard(
                padding: EdgeInsets.zero,
                borderColor: _open == i ? Mhn.green : Mhn.line,
                child: Column(children: [
                  InkWell(
                    borderRadius: BorderRadius.circular(Mhn.rCard),
                    onTap: () => setState(() => _open = _open == i ? -1 : i),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Row(children: [
                        Expanded(child: Text(kFaqs[i].q, style: Mhn.t(14, w: FontWeight.w700, h: 1.3))),
                        AnimatedRotation(turns: _open == i ? .5 : 0, duration: const Duration(milliseconds: 180), child: const Icon(Icons.keyboard_arrow_down, color: Mhn.green)),
                      ]),
                    ),
                  ),
                  if (_open == i) Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 14), child: Align(alignment: Alignment.centerLeft, child: Text(kFaqs[i].a, style: Mhn.body))),
                ]),
              ),
            ),
      ],
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.label, required this.onTap, this.primary = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool primary;

  @override
  Widget build(BuildContext context) => Material(
        color: primary ? Mhn.green : Mhn.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: primary ? Mhn.green : Mhn.line)),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 22, color: primary ? Mhn.white : Mhn.green),
              const SizedBox(height: 6),
              Text(label, style: Mhn.t(13, w: FontWeight.w700, c: primary ? Mhn.white : Mhn.ink)),
            ]),
          ),
        ),
      );
}

/// Simple stylised map (roads, blocks, pin): no map tiles, no network.
class _MapPainter extends CustomPainter {
  const _MapPainter();
  @override
  void paint(Canvas canvas, Size s) {
    canvas.drawRect(Offset.zero & s, Paint()..color = const Color(0xFFE3ECE6));
    final block = Paint()..color = const Color(0xFFD3E4DA);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(s.width * .08, s.height * .14, s.width * .28, s.height * .24), const Radius.circular(6)), block);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(s.width * .6, s.height * .56, s.width * .3, s.height * .26), const Radius.circular(6)), block);
    final road = Paint()
      ..color = Mhn.white
      ..strokeWidth = 12
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(0, s.height * .5), Offset(s.width, s.height * .38), road);
    canvas.drawLine(Offset(s.width * .46, 0), Offset(s.width * .38, s.height), road);
    final pin = Paint()..color = Mhn.green;
    final c = Offset(s.width * .5, s.height * .44);
    canvas.drawCircle(c, 13, pin);
    canvas.drawCircle(c, 5, Paint()..color = Mhn.white);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
