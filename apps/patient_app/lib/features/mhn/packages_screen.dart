// Health packages: dynamic database packages or coloured accordion cards.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_catalog_provider.dart';
import 'mhn_data.dart';
import 'mhn_package_card.dart';
import 'mhn_shell.dart';
import 'mhn_theme.dart';

class MhnPackagesScreen extends ConsumerStatefulWidget {
  const MhnPackagesScreen({super.key});

  @override
  ConsumerState<MhnPackagesScreen> createState() => _MhnPackagesScreenState();
}

class _MhnPackagesScreenState extends ConsumerState<MhnPackagesScreen> {
  String? _open;

  @override
  Widget build(BuildContext context) {
    final packages = ref.watch(mhnCatalogProvider).packages;
    return MhnPage(
      title: 'Health packages',
      bottom: const MhnCartBar(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        children: [
          Text('Tap a package to see what it includes.', style: Mhn.body),
          const SizedBox(height: 12),
          for (final p in packages)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: MhnPackageCard(pkg: p, open: _open == p.id, onToggleOpen: () => setState(() => _open = _open == p.id ? null : p.id)),
            ),
        ],
      ),
    );
  }
}
