// CR-C16-016 widgets (C16 04-UI-UX §9.1): timeline, slot picker, segmented control, bottom nav, card,
// profile switcher, app-lock gate. Text + icon for every state (never colour-only), 48 dp targets.
import 'package:flutter/material.dart';
import 'package:lims_shared/lims_shared.dart' show adToBs, formatBs;

import 'base_widgets.dart';
import 'tokens.g.dart';

enum LimsStepState { done, current, todo, alert }

typedef LimsStep = ({String label, LimsStepState state});

class LimsStageTimeline extends StatelessWidget {
  const LimsStageTimeline({super.key, required this.steps});

  final List<LimsStep> steps;

  static (IconData, Color, String) _look(LimsStepState s) => switch (s) {
        LimsStepState.done => (Icons.check_circle, LimsTokens.colorToneSuccessFg, 'done'),
        LimsStepState.current => (Icons.radio_button_checked, LimsTokens.colorAccentDefault, 'current step'),
        LimsStepState.todo => (Icons.radio_button_unchecked, LimsTokens.colorNeutral500, 'not started'),
        LimsStepState.alert => (Icons.error, LimsTokens.colorToneDangerFg, 'needs attention'),
      };

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final s in steps)
          Semantics(
            label: '${s.label}, ${_look(s.state).$3}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
              child: Row(children: [
                Icon(_look(s.state).$1, color: _look(s.state).$2),
                const SizedBox(width: LimsTokens.space2),
                Expanded(
                  child: Text(s.label,
                      style: TextStyle(
                          fontWeight: s.state == LimsStepState.current || s.state == LimsStepState.alert ? FontWeight.w600 : FontWeight.w400,
                          color: s.state == LimsStepState.alert ? LimsTokens.colorToneDangerFg : null)),
                ),
              ]),
            ),
          ),
      ]);
}

typedef LimsSlot = ({String start, String label, int remaining});
typedef LimsSlotDay = ({String date, List<LimsSlot> slots});

/// Slot picker; remaining shown as "N left", capped "9+" (C16 04 §6). `calendarMode` 'AD' | 'BS' (B.S. via lims_shared).
class LimsSlotPicker extends StatelessWidget {
  const LimsSlotPicker({super.key, required this.days, this.selected, required this.onSelected, required this.calendarMode, this.emptyTitle = 'No slots available'});

  final List<LimsSlotDay> days;
  final String? selected;
  final ValueChanged<String> onSelected;
  final String calendarMode;
  final String emptyTitle;

  String _day(String iso) {
    if (calendarMode != 'BS') return iso;
    try {
      return '${formatBs(adToBs(iso))} B.S.';
    } catch (_) {
      return iso; // out of the B.S. table range: show A.D. rather than fail
    }
  }

  @override
  Widget build(BuildContext context) {
    if (days.isEmpty) return LimsEmptyState(title: emptyTitle, icon: Icons.event_busy);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final d in days) ...[
        Padding(
          padding: const EdgeInsets.only(top: LimsTokens.space3, bottom: LimsTokens.space2),
          child: Text(_day(d.date), style: Theme.of(context).textTheme.titleSmall),
        ),
        Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: [
          for (final s in d.slots)
            OutlinedButton(
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(LimsTokens.touchTargetFlutter, LimsTokens.touchTargetFlutter),
                backgroundColor: s.start == selected ? LimsTokens.colorAccentSubtle : null,
                side: BorderSide(color: s.start == selected ? LimsTokens.colorAccentDefault : LimsTokens.colorNeutral300),
              ),
              onPressed: s.remaining > 0 ? () => onSelected(s.start) : null,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(s.label),
                Text(s.remaining <= 0 ? 'Full' : (s.remaining > 9 ? '9+ left' : '${s.remaining} left'),
                    style: const TextStyle(fontSize: LimsTokens.fontSizeXsSize)),
              ]),
            ),
        ]),
      ],
    ]);
  }
}

class LimsSegmentedControl<T> extends StatelessWidget {
  const LimsSegmentedControl({super.key, required this.options, required this.value, required this.onChanged, this.disabled = const {}});

  final List<({T value, String label})> options;
  final T value;
  final ValueChanged<T> onChanged;

  /// Options rendered disabled (LD-164, CR-C16-T-L6 item 3). Default empty: every option enabled.
  final Set<T> disabled;

  @override
  Widget build(BuildContext context) => SegmentedButton<T>(
        segments: [for (final o in options) ButtonSegment<T>(value: o.value, label: Text(o.label), enabled: !disabled.contains(o.value))],
        selected: {value},
        onSelectionChanged: (s) => onChanged(s.first),
        style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size(LimsTokens.touchTargetFlutter, LimsTokens.touchTargetFlutter))),
      );
}

typedef LimsNavItem = ({IconData icon, String label, String? badge});

/// Bottom navigation: labels always visible; grows with text scale instead of overflowing.
class LimsBottomNav extends StatelessWidget {
  const LimsBottomNav({super.key, required this.items, required this.index, required this.onTap});

  final List<LimsNavItem> items;
  final int index;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: LimsTokens.colorNeutral0,
        elevation: 3,
        child: SafeArea(
          top: false,
          child: Row(children: [
            for (var i = 0; i < items.length; i++)
              Expanded(
                child: Semantics(
                  selected: i == index,
                  button: true,
                  child: InkResponse(
                    onTap: () => onTap(i),
                    containedInkWell: true,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 56),
                      child: Padding(
                        padding: const EdgeInsets.all(LimsTokens.space1),
                        // LD-140 / 10-DESIGN-SYSTEM s5: tap scale .96; current tab = accent.highlight (lime) pill with
                        // accent.default text (7.93:1).
                        child: LimsPressScale(
                          child: Center(
                            heightFactor: 1,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: i == index ? LimsTokens.colorAccentHighlight : null,
                                borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusFull)),
                              ),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space3, vertical: LimsTokens.space1),
                                child: Column(mainAxisSize: MainAxisSize.min, children: [
                                  Badge(
                                    isLabelVisible: items[i].badge != null,
                                    label: items[i].badge == null ? null : Text(items[i].badge!),
                                    child: Icon(items[i].icon, color: i == index ? LimsTokens.colorAccentDefault : LimsTokens.colorNeutral600),
                                  ),
                                  Text(
                                    items[i].label,
                                    maxLines: 1,
                                    softWrap: false,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: LimsTokens.fontSizeXsSize,
                                      fontWeight: i == index ? FontWeight.w600 : FontWeight.w400,
                                      color: i == index ? LimsTokens.colorAccentDefault : LimsTokens.colorNeutral700,
                                    ),
                                  ),
                                ]),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ]),
        ),
      );
}

class LimsCard extends StatelessWidget {
  const LimsCard({super.key, required this.title, required this.child, this.footer});

  final String title;
  final Widget child;
  final Widget? footer;

  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(LimsTokens.space4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: LimsTokens.space2),
            child,
            if (footer != null) ...[const Divider(height: LimsTokens.space6), footer!],
          ]),
        ),
      );
}

typedef LimsProfile = ({String id, String label, String sublabel});

/// Profile switcher with an "All profiles" option (null id). Selection is the caller's state only (not persisted here).
class LimsProfileSwitcher extends StatelessWidget {
  const LimsProfileSwitcher({super.key, required this.profiles, this.selectedId, required this.onChanged, this.allLabel = 'All profiles'});

  final List<LimsProfile> profiles;
  final String? selectedId;
  final ValueChanged<String?> onChanged;
  final String allLabel;

  Future<void> _open(BuildContext context) async {
    final picked = await showModalBottomSheet<({String? id})>(
      context: context,
      isScrollControlled: true,
      builder: (c) => SafeArea(
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ListTile(
              leading: const Icon(Icons.groups),
              title: Text(allLabel),
              selected: selectedId == null,
              onTap: () => Navigator.of(c).pop((id: null)),
            ),
            for (final p in profiles)
              ListTile(
                leading: const Icon(Icons.person),
                title: Text(p.label),
                subtitle: Text(p.sublabel),
                selected: p.id == selectedId,
                onTap: () => Navigator.of(c).pop((id: p.id)),
              ),
          ]),
        ),
      ),
    );
    if (picked != null) onChanged(picked.id);
  }

  @override
  Widget build(BuildContext context) {
    final cur = profiles.where((p) => p.id == selectedId).firstOrNull;
    return ListTile(
      leading: Icon(cur == null ? Icons.groups : Icons.person),
      title: Text(cur?.label ?? allLabel),
      subtitle: cur == null ? null : Text(cur.sublabel),
      trailing: const Icon(Icons.expand_more),
      onTap: () => _open(context),
    );
  }
}

/// App-lock gate (REQ-SEC-110): while locked the child keeps its state but is invisible, untouchable and hidden from
/// accessibility; the unlock prompt (the app's local_auth call) is requested once per lock.
class LimsAppLockGate extends StatefulWidget {
  const LimsAppLockGate({super.key, required this.child, required this.isLocked, required this.onUnlockRequested, this.unlockLabel = 'Unlock to continue'});

  final Widget child;
  final bool isLocked;
  final VoidCallback onUnlockRequested;
  final String unlockLabel;

  @override
  State<LimsAppLockGate> createState() => _LimsAppLockGateState();
}

class _LimsAppLockGateState extends State<LimsAppLockGate> {
  void _request() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.isLocked) widget.onUnlockRequested();
      });

  @override
  void initState() {
    super.initState();
    if (widget.isLocked) _request();
  }

  @override
  void didUpdateWidget(LimsAppLockGate old) {
    super.didUpdateWidget(old);
    if (widget.isLocked && !old.isLocked) _request();
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        Visibility(
          visible: !widget.isLocked,
          maintainState: true,
          maintainAnimation: true,
          maintainSize: true,
          child: widget.child,
        ),
        if (widget.isLocked)
          Positioned.fill(
            child: ColoredBox(
              color: Theme.of(context).colorScheme.surface,
              child: Center(
                child: SingleChildScrollView(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.lock, size: 32),
                    LimsButton(label: widget.unlockLabel, onPressed: widget.onUnlockRequested),
                  ]),
                ),
              ),
            ),
          ),
      ]);
}
