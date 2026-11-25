// Phlebotomist look (spec/program/design-m-series M5 board + the MyHealthNow wireframe pack): forest header with rounded
// bottom, lime pill primary button with dark text, white cards. Everything comes from LimsTokens (13-M-SERIES s6.3: no
// colour, radius, font-size or duration literal in app code). Only the theme is changed here, so every LimsScaffold /
// LimsButton screen of the app picks the look up without a widget swap (LD-140 chrome rules stay true).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lims_ui/lims_ui.dart';

/// Gradients are built from the accent tokens, never from literals: deep teal, brand teal, then a green between teal and lime.
abstract final class PhleboGradients {
  static final Color green = Color.lerp(LimsTokens.colorAccentDefault, LimsTokens.colorAccentHighlight, 0.3)!;

  /// Hero cards (queue progress, profile summary): board M5 `135deg, deep, teal, green`.
  static final LinearGradient hero = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [LimsTokens.colorAccentHover, LimsTokens.colorAccentDefault, green],
    stops: const [0, 0.55, 1],
  );

  /// Entry and splash art (M1): deep teal fading to lime at the bottom.
  static final LinearGradient entry = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [LimsTokens.colorAccentHover, LimsTokens.colorAccentDefault, green, LimsTokens.colorAccentHighlight],
    stops: const [0, 0.35, 0.75, 1],
  );
}

abstract final class PhleboTheme {
  /// Minimum primary-button height of the board (52 dp = touch target + one 4 dp step).
  static const double buttonHeight = LimsTokens.touchTargetFlutter + LimsTokens.space1;

  static ThemeData light() {
    final base = LimsTheme.light();
    final text = base.textTheme;
    const pill = StadiumBorder();
    return base.copyWith(
      textTheme: text.copyWith(titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      appBarTheme: AppBarTheme(
        backgroundColor: LimsTokens.colorAccentDefault,
        foregroundColor: LimsTokens.colorAccentFg,
        surfaceTintColor: LimsTokens.colorAccentDefault,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        toolbarHeight: LimsTokens.space16,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(bottom: Radius.circular(LimsTokens.radiusXl))),
        titleTextStyle: text.titleLarge?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w600),
        iconTheme: const IconThemeData(color: LimsTokens.colorAccentFg),
        actionsIconTheme: const IconThemeData(color: LimsTokens.colorAccentFg),
        systemOverlayStyle: SystemUiOverlayStyle.light,
      ),
      // Board `.btn`: lime fill, dark label (the 13-M-SERIES contrast gate: white on lime fails, neutral.900 on lime passes).
      filledButtonTheme: FilledButtonThemeData(
        style: ButtonStyle(
          shape: const WidgetStatePropertyAll(pill),
          minimumSize: const WidgetStatePropertyAll(Size(LimsTokens.touchTargetFlutter, buttonHeight)),
          backgroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.disabled) ? LimsTokens.colorToneNeutralBg : LimsTokens.colorAccentHighlight,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.disabled) ? LimsTokens.colorNeutral500 : LimsTokens.colorNeutral900,
          ),
          textStyle: WidgetStatePropertyAll(text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: ButtonStyle(
          shape: const WidgetStatePropertyAll(pill),
          minimumSize: const WidgetStatePropertyAll(Size(LimsTokens.touchTargetFlutter, buttonHeight)),
          foregroundColor: const WidgetStatePropertyAll(LimsTokens.colorNeutral900),
          side: const WidgetStatePropertyAll(BorderSide(color: LimsTokens.colorNeutral300, width: LimsTokens.space0x5)),
          textStyle: WidgetStatePropertyAll(text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: LimsTokens.colorNeutral0,
        surfaceTintColor: LimsTokens.colorNeutral0,
        showDragHandle: true,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(LimsTokens.radiusXl))),
      ),
      dividerTheme: const DividerThemeData(color: LimsTokens.colorToneNeutralBorder, space: 1, thickness: 1),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? LimsTokens.colorAccentFg : LimsTokens.colorNeutral600),
        trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? LimsTokens.colorAccentDefault : LimsTokens.colorToneNeutralBg),
      ),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
    );
  }
}
