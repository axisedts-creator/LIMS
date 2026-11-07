// 04-UI-UX §8 "Theme" / "Fonts": ThemeData from tokens.g.dart (same tokens.json as @lims/ui), Material 3 [CONV].
import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// Tone colours (04 §1.2), keyed by the same tone names as the web kit.
typedef LimsToneColors = ({Color fg, Color bg, Color border});

const limsTones = <String, LimsToneColors>{
  'neutral': (fg: LimsTokens.colorToneNeutralFg, bg: LimsTokens.colorToneNeutralBg, border: LimsTokens.colorToneNeutralBorder),
  'info': (fg: LimsTokens.colorToneInfoFg, bg: LimsTokens.colorToneInfoBg, border: LimsTokens.colorToneInfoBorder),
  'success': (fg: LimsTokens.colorToneSuccessFg, bg: LimsTokens.colorToneSuccessBg, border: LimsTokens.colorToneSuccessBorder),
  'warning': (fg: LimsTokens.colorToneWarningFg, bg: LimsTokens.colorToneWarningBg, border: LimsTokens.colorToneWarningBorder),
  'danger': (fg: LimsTokens.colorToneDangerFg, bg: LimsTokens.colorToneDangerBg, border: LimsTokens.colorToneDangerBorder),
  'critical': (fg: LimsTokens.colorToneCriticalFg, bg: LimsTokens.colorToneCriticalBg, border: LimsTokens.colorToneCriticalBorder),
};

LimsToneColors limsTone(String tone) => limsTones[tone] ?? limsTones['neutral']!;

abstract final class LimsTheme {
  /// Fonts are bundled package assets (no runtime download, 04 §11). Inside this package they resolve as 'Noto Sans';
  /// from an app they resolve as 'packages/lims_ui/<family>', hence both spellings in the fallback list [CONV].
  static const fontFamily = 'Noto Sans';
  static const fontFamilyFallback = [
    'Noto Sans Devanagari',
    'packages/lims_ui/Noto Sans',
    'packages/lims_ui/Noto Sans Devanagari',
  ];
  static const monoFamily = 'packages/lims_ui/Noto Sans Mono';

  static ThemeData light({Color? accent}) {
    final primary = accent ?? LimsTokens.colorAccentDefault;
    final scheme = ColorScheme.fromSeed(seedColor: primary).copyWith(
      primary: primary,
      onPrimary: LimsTokens.colorAccentFg,
      error: LimsTokens.colorToneDangerFg,
      onError: LimsTokens.colorNeutral0,
      surface: LimsTokens.colorNeutral0,
      onSurface: LimsTokens.colorNeutral900,
      outline: LimsTokens.colorNeutral300,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: scheme,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFamilyFallback,
      materialTapTargetSize: MaterialTapTargetSize.padded, // 48 dp (04 §8 Accessibility)
      visualDensity: VisualDensity.standard,
      scaffoldBackgroundColor: LimsTokens.colorNeutral50,
    );
  }
}
