// My profile: completeness ring + hint, the detail rows ("Not added" in amber) and Edit profile.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'edit_profile_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMyProfileScreen extends ConsumerWidget {
  const MhnMyProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(mhnProvider.select((s) => s.profile));
    final pct = p.completeness;
    final missing = [if (p.email.isEmpty) 'email', if (p.dob.isEmpty) 'date of birth', if (p.blood.isEmpty) 'blood group'];
    final age = p.dob.isEmpty ? null : ageFrom(p.dob);
    final rows = <(String, String)>[
      ('Name', p.name),
      ('Phone', '+977 ${p.phone}'),
      ('Email', p.email.isEmpty ? 'Not added' : p.email),
      ('Date of birth', p.dob.isEmpty ? 'Not added' : '${dateLong(DateTime.parse(p.dob))}${age == null ? '' : ' ($age yrs)'}'),
      ('Gender', p.gender),
      ('Blood group', p.blood.isEmpty ? 'Not added' : p.blood),
      ('Height', '${p.height} cm'),
      ('Weight', '${p.weight} kg'),
    ];
    return MhnPage(
      title: 'My profile',
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: Mhn.green, borderRadius: BorderRadius.circular(Mhn.rCard)),
            child: Row(children: [
              SizedBox(
                width: 60,
                height: 60,
                child: CustomPaint(painter: _Ring(pct / 100), child: Center(child: Text('$pct%', style: Mhn.t(13, w: FontWeight.w800, c: Mhn.white)))),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(pct == 100 ? 'Profile complete' : 'Complete your profile', style: Mhn.t(16, w: FontWeight.w800, c: Mhn.white)),
                  const SizedBox(height: 2),
                  Text(missing.isEmpty ? 'All your details are up to date.' : 'Add your ${missing.join(', ')}.', style: Mhn.t(13, c: const Color(0xE6FFFFFF), h: 1.3)),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < rows.length; i++)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                  decoration: BoxDecoration(border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null),
                  child: Row(children: [
                    Text(rows[i].$1, style: Mhn.t(14, c: Mhn.muted)),
                    const Spacer(),
                    Flexible(child: Text(rows[i].$2, textAlign: TextAlign.right, style: Mhn.t(14, w: FontWeight.w700, c: rows[i].$2 == 'Not added' ? Mhn.warnFg : Mhn.ink))),
                  ]),
                ),
            ]),
          ),
          const SizedBox(height: 16),
          MhnButton(label: 'Edit profile', icon: Icons.edit_outlined, onPressed: () => mhnPush<void>(context, const MhnEditProfileScreen())),
        ],
      ),
    );
  }
}

class _Ring extends CustomPainter {
  const _Ring(this.value);
  final double value;
  @override
  void paint(Canvas canvas, Size s) {
    final r = Rect.fromLTWH(4, 4, s.width - 8, s.height - 8);
    canvas.drawArc(r, 0, math.pi * 2, false, Paint()..style = PaintingStyle.stroke..strokeWidth = 6..color = const Color(0x33FFFFFF));
    canvas.drawArc(r, -math.pi / 2, math.pi * 2 * value, false, Paint()..style = PaintingStyle.stroke..strokeWidth = 6..strokeCap = StrokeCap.round..color = Mhn.lime);
  }

  @override
  bool shouldRepaint(covariant _Ring old) => old.value != value;
}
