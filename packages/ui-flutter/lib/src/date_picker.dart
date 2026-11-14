// 04-UI-UX §8 LimsDatePicker (A.D./B.S.). 04 D13: the B.S. grid comes from nepali_date_picker 8.0.0 inside this widget
// only; values in and out are A.D. ISO dates converted through lims_shared/bsdate (never the picker's own calendar).
import 'package:flutter/material.dart';
import 'package:lims_shared/lims_shared.dart' show BsDate, adToBs, bsToAd, formatBs;
import 'package:nepali_date_picker/nepali_date_picker.dart' as np;

String _iso(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

class LimsDatePicker extends StatelessWidget {
  const LimsDatePicker({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    required this.firstDate,
    required this.lastDate,
    this.calendarMode = 'AD',
    this.errorText,
  });

  final String label;
  final String? value; // A.D. ISO date
  final ValueChanged<String> onChanged; // A.D. ISO date
  final String firstDate, lastDate; // A.D. ISO dates
  final String calendarMode; // 'AD' | 'BS'
  final String? errorText;

  bool get _bs => calendarMode == 'BS';

  String _display(String iso) {
    if (!_bs) return iso;
    try {
      return '${formatBs(adToBs(iso))} B.S.';
    } catch (_) {
      return iso;
    }
  }

  Future<void> _pick(BuildContext context) async {
    final initial = value ?? _iso(DateTime.now());
    if (_bs) {
      np.NepaliDateTime n(String iso) {
        final b = adToBs(iso);
        return np.NepaliDateTime(b.year, b.month, b.day);
      }

      final r = await np.showNepaliDatePicker(context: context, initialDate: n(initial), firstDate: n(firstDate), lastDate: n(lastDate));
      if (r != null) onChanged(bsToAd(BsDate(r.year, r.month, r.day)));
      return;
    }
    final r = await showDatePicker(
      context: context,
      initialDate: DateTime.parse(initial),
      firstDate: DateTime.parse(firstDate),
      lastDate: DateTime.parse(lastDate),
    );
    if (r != null) onChanged(_iso(r));
  }

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: () => _pick(context),
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, errorText: errorText, suffixIcon: const Icon(Icons.calendar_today)),
          child: Text(value == null ? '' : _display(value!)),
        ),
      );
}
