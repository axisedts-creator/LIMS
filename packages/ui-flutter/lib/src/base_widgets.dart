// 04-UI-UX §8 base widgets. State-agnostic (Riverpod lives in the apps), 48 dp targets, text scale up to 2.0,
// sensitive fields without suggestions/autocorrect (REQ-SEC-111).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'status.dart';
import 'theme.dart';
import 'tokens.g.dart';

const _minTarget = LimsTokens.touchTargetFlutter;

/// LD-140 / 10-DESIGN-SYSTEM s2 motion + s5: mobile press scale .96, motion.duration.fast. A [Listener] (not a gesture
/// recognizer) so the child's own tap handling is untouched. `enabled: false` = no scale (disabled controls).
class LimsPressScale extends StatefulWidget {
  const LimsPressScale({super.key, required this.child, this.enabled = true});

  static const pressedScale = 0.96;

  final Widget child;
  final bool enabled;

  @override
  State<LimsPressScale> createState() => _LimsPressScaleState();
}

class _LimsPressScaleState extends State<LimsPressScale> {
  var _down = false;

  void _set(bool v) {
    if (_down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Listener(
      onPointerDown: widget.enabled ? (_) => _set(true) : null,
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: AnimatedScale(
        scale: _down && widget.enabled ? LimsPressScale.pressedScale : 1,
        duration: reduce ? Duration.zero : Duration(milliseconds: LimsTokens.motionDurationFast.round()),
        curve: const Cubic(0.2, 0, 0, 1), // tokens motion.easing
        child: widget.child,
      ),
    );
  }
}

class LimsButton extends StatelessWidget {
  const LimsButton({super.key, required this.label, required this.onPressed, this.icon, this.secondary = false});

  final String label;
  final VoidCallback? onPressed; // null = disabled
  final IconData? icon;
  final bool secondary;

  @override
  Widget build(BuildContext context) {
    // LD-140: pill shape + 48 dp minimum (also in LimsTheme, repeated so the button holds outside LimsTheme).
    const style = ButtonStyle(
      minimumSize: WidgetStatePropertyAll(Size(_minTarget, _minTarget)),
      shape: WidgetStatePropertyAll(StadiumBorder()),
    );
    final text = Text(label, textAlign: TextAlign.center);
    final Widget button;
    if (secondary) {
      button = icon == null
          ? OutlinedButton(onPressed: onPressed, style: style, child: text)
          : OutlinedButton.icon(onPressed: onPressed, style: style, icon: Icon(icon), label: text);
    } else {
      button = icon == null
          ? FilledButton(onPressed: onPressed, style: style, child: text)
          : FilledButton.icon(onPressed: onPressed, style: style, icon: Icon(icon), label: text);
    }
    return LimsPressScale(enabled: onPressed != null, child: button);
  }
}

/// Text field; `maxLength` is required (04 §8). `sensitive` turns off suggestions + autocorrect (REQ-SEC-111).
class LimsTextField extends StatelessWidget {
  const LimsTextField({
    super.key,
    required this.label,
    required this.maxLength,
    this.sensitive = false,
    this.controller,
    this.onChanged,
    this.errorText,
    this.keyboardType,
    this.inputFormatters,
    this.obscureText = false,
  });

  final String label;
  final int maxLength;
  final bool sensitive;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;
  final String? errorText;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final bool obscureText;

  @override
  Widget build(BuildContext context) => TextField(
        controller: controller,
        onChanged: onChanged,
        maxLength: maxLength,
        maxLengthEnforcement: MaxLengthEnforcement.enforced,
        enableSuggestions: !sensitive && !obscureText,
        autocorrect: !sensitive && !obscureText,
        obscureText: obscureText,
        keyboardType: keyboardType,
        inputFormatters: inputFormatters,
        decoration: InputDecoration(labelText: label, errorText: errorText, errorMaxLines: 3),
      );
}

/// Decimal entry as text (no binary floats): digits with at most one '.' and `scale` fraction digits.
class LimsDecimalField extends StatelessWidget {
  const LimsDecimalField({super.key, required this.label, this.scale = 2, this.maxLength = 18, this.onChanged, this.errorText, this.controller});

  final String label;
  final int scale;
  final int maxLength;
  final ValueChanged<String>? onChanged;
  final String? errorText;
  final TextEditingController? controller;

  @override
  Widget build(BuildContext context) => LimsTextField(
        label: label,
        maxLength: maxLength,
        controller: controller,
        onChanged: onChanged,
        errorText: errorText,
        sensitive: true,
        keyboardType: TextInputType.numberWithOptions(decimal: scale > 0),
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(scale > 0 ? '^\\d*\\.?\\d{0,$scale}' : r'^\d*'))],
      );
}

/// Money entry in rupees, emitted as integer paisa (lims_shared Money.amountPaisa); null when empty.
class LimsMoneyField extends StatelessWidget {
  const LimsMoneyField({super.key, required this.label, required this.onChanged, this.errorText, this.controller});

  final String label;
  final ValueChanged<int?> onChanged;
  final String? errorText;
  final TextEditingController? controller;

  static int? toPaisa(String s) {
    final m = RegExp(r'^(\d+)(?:\.(\d{0,2}))?$').firstMatch(s);
    if (m == null) return null;
    return int.parse(m[1]!) * 100 + int.parse((m[2] ?? '').padRight(2, '0'));
  }

  @override
  Widget build(BuildContext context) => LimsDecimalField(
        label: label,
        maxLength: 15,
        controller: controller,
        errorText: errorText,
        onChanged: (s) => onChanged(toPaisa(s)),
      );
}

/// Result value + unit + flag (flag is text, never colour-only).
class LimsResultValue extends StatelessWidget {
  const LimsResultValue({super.key, required this.value, this.unit, this.flag});

  final String value;
  final String? unit;
  final String? flag;

  @override
  Widget build(BuildContext context) => Wrap(
        spacing: LimsTokens.space2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(value, style: const TextStyle(fontWeight: FontWeight.w600, fontFamily: LimsTheme.monoFamily)),
          if (unit != null) Text(unit!),
          if (flag != null) LimsFlagBadge(flag: flag!),
        ],
      );
}

class LimsListTile extends StatelessWidget {
  const LimsListTile({super.key, required this.title, this.subtitle, this.leading, this.trailing, this.onTap});

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
        constraints: const BoxConstraints(minHeight: _minTarget),
        child: ListTile(
          title: Text(title),
          subtitle: subtitle == null ? null : Text(subtitle!),
          leading: leading,
          trailing: trailing,
          onTap: onTap,
        ),
      );
}

class LimsEmptyState extends StatelessWidget {
  const LimsEmptyState({super.key, required this.title, this.message, this.icon = Icons.inbox_outlined});

  final String title;
  final String? message;
  final IconData icon;

  @override
  Widget build(BuildContext context) => _StateBox(icon: icon, title: title, message: message);
}

class LimsErrorState extends StatelessWidget {
  const LimsErrorState({super.key, required this.title, this.message, this.onRetry, this.retryLabel = 'Retry'});

  final String title;
  final String? message;
  final VoidCallback? onRetry;
  final String retryLabel;

  @override
  Widget build(BuildContext context) => _StateBox(
        icon: Icons.error_outline,
        iconColor: LimsTokens.colorToneDangerFg,
        title: title,
        message: message,
        action: onRetry == null ? null : LimsButton(label: retryLabel, onPressed: onRetry, secondary: true),
      );
}

class _StateBox extends StatelessWidget {
  const _StateBox({required this.icon, required this.title, this.message, this.action, this.iconColor});

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(LimsTokens.space6),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 40, color: iconColor ?? LimsTokens.colorNeutral500),
        const SizedBox(height: LimsTokens.space2),
        Text(title, style: t.titleMedium, textAlign: TextAlign.center),
        if (message != null) ...[
          const SizedBox(height: LimsTokens.space1),
          Text(message!, style: t.bodyMedium, textAlign: TextAlign.center),
        ],
        if (action != null) ...[const SizedBox(height: LimsTokens.space4), action!],
      ]),
    );
  }
}

class LimsLoading extends StatelessWidget {
  const LimsLoading({super.key, this.label = 'Loading'});

  final String label;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(LimsTokens.space4),
          child: CircularProgressIndicator(semanticsLabel: label),
        ),
      );
}

class LimsOfflineBanner extends StatelessWidget {
  const LimsOfflineBanner({super.key, this.message = 'You are offline. Changes are saved on this device and sync later.'});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = limsTone('warning');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Container(
        width: double.infinity,
        color: c.bg,
        padding: const EdgeInsets.all(LimsTokens.space3),
        child: Row(children: [
          Icon(Icons.cloud_off, color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(message, style: TextStyle(color: c.fg))),
        ]),
      ),
    );
  }
}

/// Offline queue counts for C17 (queued / syncing / synced / error).
class LimsSyncStatus extends StatelessWidget {
  const LimsSyncStatus({super.key, required this.queued, required this.syncing, required this.synced, required this.error});

  final int queued, syncing, synced, error;

  @override
  Widget build(BuildContext context) => Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space1, children: [
        if (syncing > 0)
          const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Syncing')),
        LimsStatusChip(kind: 'generic', status: 'queued', tone: 'neutral', label: '$queued queued'),
        LimsStatusChip(kind: 'generic', status: 'syncing', tone: 'info', label: '$syncing syncing'),
        LimsStatusChip(kind: 'generic', status: 'synced', tone: 'success', label: '$synced synced'),
        LimsStatusChip(kind: 'generic', status: 'error', tone: error > 0 ? 'danger' : 'neutral', label: '$error failed'),
      ]);
}

/// App scaffold with offline-banner and sync-status slots.
class LimsScaffold extends StatelessWidget {
  const LimsScaffold({super.key, required this.title, required this.body, this.offlineBanner, this.syncStatus, this.actions, this.bottomNavigationBar});

  final String title;
  final Widget body;
  final Widget? offlineBanner;
  final Widget? syncStatus;
  final List<Widget>? actions;
  final Widget? bottomNavigationBar;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(title), actions: actions),
        bottomNavigationBar: bottomNavigationBar,
        body: Column(children: [
          ?offlineBanner,
          if (syncStatus != null) Padding(padding: const EdgeInsets.all(LimsTokens.space2), child: syncStatus),
          Expanded(child: body),
        ]),
      );
}

abstract final class LimsSnackbar {
  static void show(BuildContext context, String message, {String tone = 'neutral'}) {
    final c = limsTone(tone);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      backgroundColor: c.bg,
      content: Text(message, style: TextStyle(color: c.fg)),
    ));
  }
}

/// Screenshot / recents protection for PHI screens (REQ-SEC-109). The platform side is the app's own small channel
/// (C17 TRD §2: FLAG_SECURE via in-app platform channel) [CONV channel name]; missing channel = no-op.
class LimsSecureScreen extends StatefulWidget {
  const LimsSecureScreen({super.key, required this.child});

  final Widget child;
  static const channel = MethodChannel('lims_ui/secure_screen');

  @override
  State<LimsSecureScreen> createState() => _LimsSecureScreenState();
}

class _LimsSecureScreenState extends State<LimsSecureScreen> {
  static Future<void> _call(String m) async {
    try {
      await LimsSecureScreen.channel.invokeMethod<void>(m);
    } on MissingPluginException {
      // platform without the hook (tests, web, desktop)
    } on PlatformException {
      // hook present but refused; screen still renders
    }
  }

  static var _active = 0; // nested/stacked PHI screens: protection stays on until the last one leaves

  @override
  void initState() {
    super.initState();
    if (_active++ == 0) _call('enable');
  }

  @override
  void dispose() {
    if (--_active == 0) _call('disable');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
