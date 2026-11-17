// Health packages: five coloured accordion cards (Bronze..Elite).
import 'package:flutter/material.dart';

import 'mhn_data.dart';
import 'mhn_package_card.dart';
import 'mhn_shell.dart';
import 'mhn_theme.dart';

class MhnPackagesScreen extends StatefulWidget {
  const MhnPackagesScreen({super.key});

  @override
  State<MhnPackagesScreen> createState() => _MhnPackagesScreenState();
}

class _MhnPackagesScreenState extends State<MhnPackagesScreen> {
  String? _open;

  @override
  Widget build(BuildContext context) => MhnPage(
        title: 'Health packages',
        bottom: const MhnCartBar(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          children: [
            Text('Tap a package to see what it includes.', style: Mhn.body),
            const SizedBox(height: 12),
            for (final p in kPackages)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: MhnPackageCard(pkg: p, open: _open == p.id, onToggleOpen: () => setState(() => _open = _open == p.id ? null : p.id)),
              ),
            Text('Package contents and prices are sample until Metro Labs sends the final list.', style: Mhn.small),
          ],
        ),
      );
}
