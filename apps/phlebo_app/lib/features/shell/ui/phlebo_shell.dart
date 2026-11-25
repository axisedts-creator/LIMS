// Tab shell: Today, History, Alerts, Profile (the wireframe pack's floating bar; board M5 has the same first three).
// Each tab is a full screen with its own header; the shell only owns the floating bar and keeps tab state alive.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

enum PhleboTab { today, history, alerts, profile }

class PhleboShell extends StatefulWidget {
  const PhleboShell({super.key, required this.pages, this.initial = PhleboTab.today, this.alertsBadge, this.onTabChanged});

  /// One page per [PhleboTab], in enum order.
  final Map<PhleboTab, Widget> pages;
  final PhleboTab initial;

  /// Unread alert count (null or 0 = no badge).
  final int? alertsBadge;
  final ValueChanged<PhleboTab>? onTabChanged;

  @override
  State<PhleboShell> createState() => _PhleboShellState();
}

class _PhleboShellState extends State<PhleboShell> {
  late PhleboTab _tab = widget.initial;

  List<LimsNavItem> get _items => [
        (icon: Icons.route_outlined, label: 'Today', badge: null),
        (icon: Icons.history, label: 'History', badge: null),
        (icon: Icons.notifications_none, label: 'Alerts', badge: (widget.alertsBadge ?? 0) > 0 ? '${widget.alertsBadge}' : null),
        (icon: Icons.person_outline, label: 'Profile', badge: null),
      ];

  @override
  Widget build(BuildContext context) => Scaffold(
        body: IndexedStack(index: _tab.index, children: [for (final t in PhleboTab.values) widget.pages[t] ?? const SizedBox.shrink()]),
        bottomNavigationBar: PhleboFloatingNav(
          items: _items,
          index: _tab.index,
          onTap: (i) {
            setState(() => _tab = PhleboTab.values[i]);
            widget.onTabChanged?.call(_tab);
          },
        ),
      );
}
