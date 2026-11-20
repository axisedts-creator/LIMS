// 04-UI-UX §8 "Theme" / "Fonts": ThemeData from tokens.g.dart (same tokens.json as @lims/ui), Material 3 [CONV].
// T0D-MSERIES-3 (LD-251, LD-246; 13-M-SERIES s2, s5): M series look through the tokens only.
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
  /// LD-251 / 13-M-SERIES s2.2: the first family of the font.family.sans token (Poppins), Devanagari fallback. Fonts are
  /// bundled package assets (no runtime download, 04 §11). Inside this package they resolve as '<family>'; from an app
  /// they resolve as 'packages/lims_ui/<family>', hence both spellings in the fallback list [CONV]. Noto Sans stays as
  /// last Latin fallback.
  static final fontFamily = RegExp(r'"([^"]+)"').firstMatch(LimsTokens.fontFamilySans)!.group(1)!;
  static final fontFamilyFallback = [
    'Noto Sans Devanagari',
    'packages/lims_ui/$fontFamily',
    'packages/lims_ui/Noto Sans Devanagari',
    'Noto Sans',
    'packages/lims_ui/Noto Sans',
  ];

  /// 13-M-SERIES s2.3: fully round buttons, 48 dp high (touch.target.flutter).
  static const _buttonShape = WidgetStatePropertyAll<OutlinedBorder>(StadiumBorder());
  static const _buttonMin = WidgetStatePropertyAll(Size(LimsTokens.touchTargetFlutter, LimsTokens.touchTargetFlutter));
  // M3 default outline is scheme.outline (neutral.300, >= 3:1 on the page); set explicitly so it never falls back.
  static const _outlineSide = WidgetStatePropertyAll(BorderSide(color: LimsTokens.colorNeutral300));
  static const _cardShape = RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusXl)));
  // 13-M-SERIES s2.3: single-line fields fully round (radius.xl = half of a 48 dp field), neutral.300 control border.
  static const _fieldRadius = BorderRadius.all(Radius.circular(LimsTokens.radiusXl));
  static const _fieldBorder = OutlineInputBorder(borderRadius: _fieldRadius, borderSide: BorderSide(color: LimsTokens.colorNeutral300));
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
      scaffoldBackgroundColor: LimsTokens.colorNeutral50, // LD-251: page #F3F3F3
      // LD-251 / 13 s2.3: white cards, radius.xl (24), flat on the page colour, no border; dialogs share the radius.
      cardTheme: const CardThemeData(
        color: LimsTokens.colorNeutral0,
        surfaceTintColor: LimsTokens.colorNeutral0,
        elevation: 0,
        shape: _cardShape,
      ),
      dialogTheme: const DialogThemeData(backgroundColor: LimsTokens.colorNeutral0, surfaceTintColor: LimsTokens.colorNeutral0, shape: _cardShape),
      inputDecorationTheme: const InputDecorationTheme(
        border: _fieldBorder,
        enabledBorder: _fieldBorder,
        focusedBorder: OutlineInputBorder(borderRadius: _fieldRadius, borderSide: BorderSide(color: LimsTokens.colorFocusRing, width: 2)),
        errorBorder: OutlineInputBorder(borderRadius: _fieldRadius, borderSide: BorderSide(color: LimsTokens.colorToneDangerFg)),
        focusedErrorBorder: OutlineInputBorder(borderRadius: _fieldRadius, borderSide: BorderSide(color: LimsTokens.colorToneDangerFg, width: 2)),
        contentPadding: EdgeInsets.symmetric(horizontal: LimsTokens.space5, vertical: LimsTokens.space3),
      ),
      filledButtonTheme: const FilledButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin)),
      outlinedButtonTheme: const OutlinedButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin, side: _outlineSide)),
      textButtonTheme: const TextButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin)),
    );
  }
}
