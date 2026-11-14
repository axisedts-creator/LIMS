// A6 Profiles (04-UI-UX A6; 03-APP-FLOW §10.1 A6; US-EN-03.2, US-EN-04.1, US-EN-05.1, US-EN-06.1/.4/.5). E13 list, E18 change relationship, E19 remove.
// Paused links are only counted (banner), never listed. PHI screen: LimsSecureScreen (REQ-SEC-109). LD-140: lims_ui widgets and tokens only; one primary
// button (the first add action). Names stay in widget state: nothing here logs or stores them.
// E18/E19 send the row's Profile.version as If-Match (LD-164); a stale edit gets the existing version_conflict copy.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../auth/auth_providers.dart';
import 'link_code_screen.dart';
import 'profile_copy.dart';
import 'profiles_providers.dart';
import 'register_screen.dart';
import 'report_link_screen.dart';

const _addCode = 'I have a code from the lab';
const _addReport = 'Add from a report message';
const _addRegister = 'Register myself / my child';

class ProfilesScreen extends ConsumerStatefulWidget {
  const ProfilesScreen({super.key, this.onProfileAdded});

  /// Called with the profile id after A7, A8 or A9 added one (the list has been read again by then).
  final void Function(String profileId)? onProfileAdded;

  @override
  ConsumerState<ProfilesScreen> createState() => _ProfilesScreenState();
}

class _ProfilesScreenState extends ConsumerState<ProfilesScreen> {
  ProfileList? _list;
  bool _loading = true;
  bool _failed = false;
  bool _canRegister = false; // E1 consent.text_version present; a failed E1 hides [Register] but nothing else
  bool _acting = false;
  String? _notice;

  @override
  void initState() {
    super.initState();
    _load();
    _loadConsent();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final list = parseProfileList(await ref.read(profilesApiProvider).listMyProfiles());
      if (mounted) {
        setState(() {
          _list = list;
          _failed = false;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _failed = true;
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadConsent() async {
    try {
      final consent = await readConsent(ref.read(patientAuthApiProvider));
      if (mounted) setState(() => _canRegister = consent != null);
    } catch (_) {
      // E1 failed: the other two actions still work
    }
  }

  void _open(Widget screen) => Navigator.of(context).push<void>(MaterialPageRoute<void>(builder: (_) => screen));

  void _added(String profileId) {
    Navigator.of(context).pop(); // A7 / A8 / A9
    _load(silent: true);
    widget.onProfileAdded?.call(profileId);
  }

  Future<void> _change(ProfileItem p) async {
    final picked = await LimsDialog.show<String>(
      context,
      title: 'Change relationship',
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        for (final choice in relationshipLabels.entries)
          ListTile(
            contentPadding: EdgeInsets.zero,
            selected: choice.key == p.relationship,
            leading: Icon(choice.key == p.relationship ? Icons.radio_button_checked : Icons.radio_button_unchecked),
            title: Text(choice.value),
            onTap: () => Navigator.of(context).pop(choice.key),
          ),
      ]),
      actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel'))],
    );
    if (picked == null || picked == p.relationship) return;
    await _act(() => ref.read(profilesApiProvider).updateMyProfile(profileId: p.id, relationship: picked, version: p.version));
  }

  Future<void> _remove(ProfileItem p) async {
    final ok = await LimsConfirmDialog.show(
      context,
      title: 'Remove ${p.name}?',
      message: "You'll stop seeing their orders and reports in this app.",
      confirmLabel: 'Remove',
    );
    if (ok == null) return;
    await _act(() => ref.read(profilesApiProvider).removeMyProfile(profileId: p.id, version: p.version));
  }

  /// One change at a time; afterwards the list is read again. A refusal shows words and leaves the list as it was,
  /// except "gone" / "changed meanwhile", where the fresh list is the answer.
  Future<void> _act(Future<void> Function() call) async {
    if (_acting) return;
    _acting = true;
    setState(() => _notice = null);
    try {
      await call();
      await _load(silent: true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _notice = genericError);
      if (e is LimsException && (e.code == LimsErrorCodes.commonNotFound || e.code == LimsErrorCodes.commonVersionConflict)) await _load(silent: true);
    } finally {
      _acting = false;
    }
  }

  String _subtitle(ProfileItem p) {
    final rel = relationshipLabels[p.relationship] ?? '';
    final method = methodText[p.method] ?? '';
    return [rel, method].where((s) => s.isNotEmpty).join(' · ');
  }

  Widget _tile(ProfileItem p) => LimsListTile(
        title: p.name,
        subtitle: _subtitle(p),
        trailing: PopupMenuButton<String>(
          icon: const Icon(Icons.more_horiz),
          tooltip: 'Actions for ${p.name}',
          onSelected: (v) => v == 'change' ? _change(p) : _remove(p),
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'change', child: Text('Change relationship')),
            PopupMenuItem(value: 'remove', child: Text('Remove')),
          ],
        ),
      );

  Widget _pending() => const LimsListTile(
        title: 'Creating record…',
        leading: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Creating record')),
      );

  Widget _pausedBanner(int n) {
    final c = limsTone('warning');
    return Container(
      padding: const EdgeInsets.all(LimsTokens.space3),
      color: c.bg,
      child: Row(children: [
        Icon(Icons.pause_circle_outline, color: c.fg),
        const SizedBox(width: LimsTokens.space2),
        Expanded(child: Text('Access to $n ${n == 1 ? 'profile is' : 'profiles are'} paused. Ask the lab for a new code.', style: TextStyle(color: c.fg))),
      ]),
    );
  }

  Widget _content(ProfileList list) {
    final nothing = list.profiles.isEmpty && list.pendingRelationships.isEmpty && list.paused == 0;
    const gap = SizedBox(height: LimsTokens.space2);
    return RefreshIndicator(
      onRefresh: () => _load(silent: true),
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (list.paused > 0) ...[_pausedBanner(list.paused), gap],
          if (_notice != null) ProfileNotice(_notice!),
          if (nothing) const LimsEmptyState(title: 'No profiles yet', message: 'Add a profile to see its orders and reports here.'),
          for (final p in list.profiles) _tile(p),
          for (final _ in list.pendingRelationships) _pending(),
          const SizedBox(height: LimsTokens.space4),
          LimsButton(label: _addCode, onPressed: () => _open(LinkCodeScreen(onAdded: _added))),
          gap,
          LimsButton(label: _addReport, secondary: true, onPressed: () => _open(ReportLinkScreen(onAdded: _added))),
          if (_canRegister) ...[
            gap,
            LimsButton(label: _addRegister, secondary: true, onPressed: () => _open(RegisterScreen(onCreated: _added))),
          ],
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final list = _list;
    final Widget body;
    if (_loading) {
      body = const LimsLoading();
    } else if (_failed && list == null) {
      body = LimsErrorState(title: 'Could not load your profiles', message: 'Check your connection and try again.', onRetry: _load);
    } else if (list == null) {
      body = const LimsLoading();
    } else {
      body = _content(list);
    }
    return LimsSecureScreen(child: LimsScaffold(title: 'Profiles', body: body));
  }
}
