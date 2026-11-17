// CR-C16-016 inputs (C16 04-UI-UX §9.1): LimsPhoneField, LimsOtpField, LimsCodeField. No suggestions/autocorrect
// on any of them (REQ-SEC-111).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tokens.g.dart';

/// One-time code: single semantic field, digits only, `oneTimeCode` autofill (C16 04 §3).
class LimsOtpField extends StatelessWidget {
  const LimsOtpField({super.key, this.length = 6, required this.onCompleted, this.errorText, this.autofocus = false, this.label = 'One-time code'});

  final int length;
  final ValueChanged<String> onCompleted;
  final String? errorText;
  final bool autofocus;
  final String label;

  @override
  Widget build(BuildContext context) => TextField(
        autofocus: autofocus,
        keyboardType: TextInputType.number,
        autofillHints: const [AutofillHints.oneTimeCode],
        enableSuggestions: false,
        autocorrect: false,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: LimsTokens.fontSize2xlSize, letterSpacing: 8),
        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(length)],
        decoration: InputDecoration(labelText: label, errorText: errorText, counterText: ''),
        onChanged: (v) {
          if (v.length == length) onCompleted(v);
        },
      );
}

/// Phone entry; emits E.164 (`prefix` + national digits), 15 digits max (C16 04 §3). Display is not reformatted.
class LimsPhoneField extends StatefulWidget {
  LimsPhoneField({
    super.key,
    required this.label,
    required this.prefixes,
    required this.initialPrefix,
    required this.onChanged,
    this.errorText,
  }) {
    if (!RegExp(r'^\+[1-9][0-9]{0,3}$').hasMatch(initialPrefix) || !prefixes.contains(initialPrefix)) {
      throw ArgumentError.value(initialPrefix, 'initialPrefix', 'must be one of prefixes');
    }
  }

  final String label;
  final List<String> prefixes;
  final String initialPrefix;
  final ValueChanged<String> onChanged;
  final String? errorText;

  @override
  State<LimsPhoneField> createState() => _LimsPhoneFieldState();
}

class _LimsPhoneFieldState extends State<LimsPhoneField> {
  late String _prefix = widget.initialPrefix;
  final _ctrl = TextEditingController();

  int get _national => 15 - (_prefix.length - 1);

  void _emit() => widget.onChanged('$_prefix${_ctrl.text}');

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.only(top: LimsTokens.space2, right: LimsTokens.space2),
          child: widget.prefixes.length == 1
              ? Text(_prefix)
              : DropdownButton<String>(
                  value: _prefix,
                  items: [for (final p in widget.prefixes) DropdownMenuItem(value: p, child: Text(p))],
                  onChanged: (p) {
                    if (p == null) return;
                    setState(() => _prefix = p);
                    if (_ctrl.text.length > _national) _ctrl.text = _ctrl.text.substring(0, _national);
                    _emit();
                  },
                ),
        ),
        Expanded(
          child: TextField(
            controller: _ctrl,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumberNational],
            enableSuggestions: false,
            autocorrect: false,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(_national)],
            decoration: InputDecoration(labelText: widget.label, errorText: widget.errorText),
            onChanged: (_) => _emit(),
          ),
        ),
      ]);
}

/// Grouped code entry `XXXXX-XXXXX` (C16 04 §4; TRD §4.3: uppercase, strip spaces/dashes, O->0, I/L->1, alphabet only).
class LimsCodeField extends StatelessWidget {
  const LimsCodeField({
    super.key,
    required this.label,
    this.groupSize = 5,
    this.groups = 2,
    required this.alphabet,
    required this.onChanged,
    this.errorText,
  });

  final String label;
  final int groupSize;
  final int groups;
  final String alphabet;
  final ValueChanged<String> onChanged;
  final String? errorText;

  /// Normalised code (no separators), capped at groupSize * groups symbols.
  static String normalise(String raw, String alphabet, int max) {
    final allowed = alphabet.toUpperCase();
    final out = StringBuffer();
    for (final ch in raw.toUpperCase().split('')) {
      final c = switch (ch) { 'O' => '0', 'I' || 'L' => '1', _ => ch };
      if (allowed.contains(c) && out.length < max) out.write(c);
    }
    return out.toString();
  }

  @override
  Widget build(BuildContext context) {
    final max = groupSize * groups;
    return TextField(
      enableSuggestions: false,
      autocorrect: false,
      textCapitalization: TextCapitalization.characters,
      keyboardType: TextInputType.visiblePassword, // no predictive bar on Android keyboards
      style: const TextStyle(letterSpacing: 2),
      inputFormatters: [_GroupFormatter((s) => normalise(s, alphabet, max), groupSize)],
      decoration: InputDecoration(labelText: label, errorText: errorText),
      onChanged: (v) => onChanged(v.replaceAll('-', '')),
    );
  }
}

class _GroupFormatter extends TextInputFormatter {
  _GroupFormatter(this.norm, this.size);

  final String Function(String) norm;
  final int size;

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final n = norm(newValue.text);
    final parts = [for (var i = 0; i < n.length; i += size) n.substring(i, i + size > n.length ? n.length : i + size)];
    final t = parts.join('-');
    return TextEditingValue(text: t, selection: TextSelection.collapsed(offset: t.length));
  }
}
