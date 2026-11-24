// Search Screen and Voice Search for My Health Now (Healthians layout v1.1).
// Provides instant live filtering across tests, packages, and categories with trending chips,
// one-tap Add to Cart, and an animated speech-to-text / voice search bottom sheet.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'cart_screen.dart';
import 'category_screen.dart';
import 'mhn_data.dart';
import 'mhn_package_card.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_test_card.dart';
import 'mhn_theme.dart';
import 'packages_screen.dart';

class MhnSearchScreen extends ConsumerStatefulWidget {
  const MhnSearchScreen({super.key, this.initialQuery});
  final String? initialQuery;

  static Future<void> open(BuildContext context, [String? query]) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MhnSearchScreen(initialQuery: query)),
    );
  }

  @override
  ConsumerState<MhnSearchScreen> createState() => _MhnSearchScreenState();
}

class _MhnSearchScreenState extends ConsumerState<MhnSearchScreen> {
  late final TextEditingController _ctrl;
  final _focus = FocusNode();
  String _query = '';

  static const _trending = [
    'Complete Blood Count (CBC)',
    'Thyroid Profile Total',
    'Lipid Profile',
    'Liver Function Test (LFT)',
    'Kidney Function Test (KFT)',
    'Full Body Checkup',
    'Vitamin D',
    'HbA1c',
  ];

  @override
  void initState() {
    super.initState();
    _query = widget.initialQuery ?? '';
    _ctrl = TextEditingController(text: _query);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_query.isEmpty) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onVoicePressed() {
    showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => const MhnVoiceSearchSheet(),
    ).then((spoken) {
      if (spoken != null && spoken.isNotEmpty && mounted) {
        setState(() {
          _ctrl.text = spoken;
          _query = spoken;
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final tokens = q.split(RegExp(r'[\s,\-_/]+')).where((w) => w.length > 1 && w != 'test' && w != 'tests' && w != 'checkup').toList();
    final matchingTests = q.isEmpty
        ? const <MhnTest>[]
        : kTests.where((t) {
            final target = '${t.name} ${t.cat} ${t.desc}'.toLowerCase();
            return target.contains(q) || (tokens.isNotEmpty && tokens.any((tok) => target.contains(tok)));
          }).toList();

    final matchingPackages = q.isEmpty
        ? const <MhnPackage>[]
        : kPackages.where((p) {
            final target = '${p.name} ${p.params} ${p.feats.join(' ')}'.toLowerCase();
            return target.contains(q) || (tokens.isNotEmpty && tokens.any((tok) => target.contains(tok)));
          }).toList();

    final matchingCategories = q.isEmpty
        ? const <MhnCategory>[]
        : kCategories.where((c) => c.name.toLowerCase().contains(q)).toList();

    final cartCount = ref.watch(mhnProvider.select((s) => s.cart.length));

    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 1,
        shadowColor: const Color(0x15000000),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Mhn.ink),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        titleSpacing: 0,
        title: Container(
          height: 44,
          margin: const EdgeInsets.only(right: 8),
          decoration: BoxDecoration(
            color: const Color(0xFFF1F5F3),
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: const Color(0xFFE0EAE4)),
          ),
          child: Row(
            children: [
              const SizedBox(width: 12),
              const Icon(Icons.search, size: 20, color: Color(0xFF1B6B52)),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  focusNode: _focus,
                  onChanged: (val) => setState(() => _query = val),
                  style: Mhn.t(14, w: FontWeight.w600, c: Mhn.ink),
                  decoration: InputDecoration(
                    hintText: 'Search tests, packages, diseases...',
                    hintStyle: Mhn.t(13, c: Mhn.muted),
                    border: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    errorBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                ),
              ),
              if (_query.isNotEmpty)
                IconButton(
                  icon: const Icon(Icons.clear, size: 18, color: Mhn.muted),
                  onPressed: () {
                    _ctrl.clear();
                    setState(() => _query = '');
                  },
                ),
              IconButton(
                icon: const Icon(Icons.mic, color: Color(0xFF1B6B52), size: 20),
                onPressed: _onVoicePressed,
              ),
            ],
          ),
        ),
        actions: [
          IconButton(
            icon: Stack(
              alignment: Alignment.center,
              children: [
                const Icon(Icons.shopping_cart_outlined, color: Mhn.ink),
                if (cartCount > 0)
                  Positioned(
                    right: 0,
                    top: 2,
                    child: Container(
                      padding: const EdgeInsets.all(3),
                      decoration: const BoxDecoration(
                        color: Color(0xFFD9EE8C),
                        shape: BoxShape.circle,
                      ),
                      child: Text(
                        '$cartCount',
                        style: Mhn.t(9, w: FontWeight.w800, c: Color(0xFF084D3B)),
                      ),
                    ),
                  ),
              ],
            ),
            onPressed: () => mhnPush<void>(context, const MhnCartScreen()),
          ),
          const SizedBox(width: 6),
        ],
      ),
      body: q.isEmpty
          ? _buildSuggestionsView()
          : _buildResultsView(matchingTests, matchingPackages, matchingCategories),
    );
  }

  Widget _buildSuggestionsView() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 80),
      children: [
        Row(
          children: [
            const Icon(Icons.trending_up, size: 18, color: Color(0xFF084D3B)),
            const SizedBox(width: 8),
            Text('Trending Searches', style: Mhn.t(14, w: FontWeight.w800, c: Mhn.ink)),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final item in _trending)
              InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: () {
                  _ctrl.text = item;
                  setState(() => _query = item);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE2ECE6)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.search, size: 14, color: Mhn.muted),
                      const SizedBox(width: 6),
                      Text(item, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.ink)),
                    ],
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 24),
        Text('Popular Categories', style: Mhn.t(14, w: FontWeight.w800, c: Mhn.ink)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final cat in kCategories)
              InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => mhnPush<void>(context, MhnCategoryScreen(category: cat)),
                child: Container(
                  width: (MediaQuery.of(context).size.width - 42) / 2,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: const Color(0xFFE2ECE6)),
                  ),
                  child: Row(
                    children: [
                      Icon(cat.icon, size: 22, color: const Color(0xFF084D3B)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(cat.name, style: Mhn.t(12, w: FontWeight.w700, c: Mhn.ink), maxLines: 1),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }

  Widget _buildResultsView(
    List<MhnTest> tests,
    List<MhnPackage> packages,
    List<MhnCategory> categories,
  ) {
    if (tests.isEmpty && packages.isEmpty && categories.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.search_off_outlined, size: 56, color: Mhn.muted),
              const SizedBox(height: 14),
              Text('No matching tests or packages', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.ink)),
              const SizedBox(height: 6),
              Text(
                'Try searching for blood test, full body checkup, thyroid, or diabetes.',
                textAlign: TextAlign.center,
                style: Mhn.t(13, c: Mhn.muted),
              ),
            ],
          ),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 80),
      children: [
        if (categories.isNotEmpty) ...[
          Text('Categories (${categories.length})', style: Mhn.t(13, w: FontWeight.w800, c: Mhn.muted)),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final cat in categories)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ActionChip(
                      avatar: Icon(cat.icon, size: 16, color: const Color(0xFF084D3B)),
                      label: Text(cat.name, style: Mhn.t(12, w: FontWeight.w700, c: const Color(0xFF084D3B))),
                      backgroundColor: const Color(0xFFE8F5E9),
                      onPressed: () => mhnPush<void>(context, MhnCategoryScreen(category: cat)),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (packages.isNotEmpty) ...[
          Row(
            children: [
              Text('Packages (${packages.length})', style: Mhn.t(14, w: FontWeight.w800, c: Mhn.ink)),
              const Spacer(),
              TextButton(
                onPressed: () => mhnPush<void>(context, const MhnPackagesScreen()),
                child: Text('View all', style: Mhn.t(12, w: FontWeight.w700, c: const Color(0xFF084D3B))),
              ),
            ],
          ),
          for (final p in packages)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: MhnPackageCard(pkg: p),
            ),
          const SizedBox(height: 16),
        ],
        if (tests.isNotEmpty) ...[
          Text('Tests (${tests.length})', style: Mhn.t(14, w: FontWeight.w800, c: Mhn.ink)),
          const SizedBox(height: 8),
          for (final t in tests)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: MhnTestCard(test: t),
            ),
        ],
      ],
    );
  }
}

/// Voice Search bottom sheet with animated audio wave pulses and instant voice selection
class MhnVoiceSearchSheet extends StatefulWidget {
  const MhnVoiceSearchSheet({super.key});

  @override
  State<MhnVoiceSearchSheet> createState() => _MhnVoiceSearchSheetState();
}

class _MhnVoiceSearchSheetState extends State<MhnVoiceSearchSheet> with SingleTickerProviderStateMixin {
  late final AnimationController _animCtrl;
  String _recognizedText = '';
  bool _listening = true;

  static const _sampleQueries = [
    'Complete Blood Count (CBC)',
    'Thyroid Profile',
    'Full Body Checkup',
    'Vitamin D Test',
    'Lipid Profile',
    'Diabetes HbA1c',
  ];

  @override
  void initState() {
    super.initState();
    _animCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);

    // Simulate speech listening recognition after a brief prompt
    Future<void>.delayed(const Duration(milliseconds: 2400), () {
      if (mounted && _recognizedText.isEmpty) {
        final sample = _sampleQueries[math.Random().nextInt(_sampleQueries.length)];
        setState(() {
          _recognizedText = sample;
          _listening = false;
        });
        Future<void>.delayed(const Duration(milliseconds: 900), () {
          if (mounted) Navigator.of(context).pop(_recognizedText);
        });
      }
    });
  }

  @override
  void dispose() {
    _animCtrl.dispose();
    super.dispose();
  }

  void _selectQuery(String q) {
    setState(() {
      _recognizedText = q;
      _listening = false;
    });
    Navigator.of(context).pop(q);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 44,
            height: 5,
            decoration: BoxDecoration(
              color: const Color(0xFFD6E2DC),
              borderRadius: BorderRadius.circular(3),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            _listening ? 'Listening for speech...' : 'Recognized!',
            style: Mhn.t(18, w: FontWeight.w800, c: const Color(0xFF084D3B)),
          ),
          const SizedBox(height: 8),
          Text(
            _listening
                ? 'Speak now or tap any test name below'
                : 'Searching for: "$_recognizedText"',
            style: Mhn.t(13, c: Mhn.muted),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          // Pulsing microphone visualizer
          AnimatedBuilder(
            animation: _animCtrl,
            builder: (_, __) {
              final scale = 1.0 + (_animCtrl.value * 0.22);
              return Stack(
                alignment: Alignment.center,
                children: [
                  Container(
                    width: 90 * scale,
                    height: 90 * scale,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: const Color(0xFF00A896).withValues(alpha: 0.18 * (1.0 - _animCtrl.value * 0.5)),
                    ),
                  ),
                  Container(
                    width: 72,
                    height: 72,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(
                        colors: [Color(0xFF00897B), Color(0xFF00A896)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Color(0x3500A896),
                          blurRadius: 16,
                          offset: Offset(0, 6),
                        ),
                      ],
                    ),
                    child: const Icon(Icons.mic, color: Colors.white, size: 36),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 24),
          Text(
            'Try saying:',
            style: Mhn.t(12, w: FontWeight.w700, c: Mhn.muted),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              for (final sample in _sampleQueries)
                InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => _selectQuery(sample),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F8F5),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFC7E27A)),
                    ),
                    child: Text(
                      sample,
                      style: Mhn.t(12, w: FontWeight.w600, c: const Color(0xFF084D3B)),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
