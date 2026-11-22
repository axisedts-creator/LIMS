# T0D-UIX-6 impl (writer)
- File changed: `apps/web/src/core/shell/shell.css` only (UIX-1 button block). kit.css / tokens.json untouched; no !important, no hex.
- Primary: 1px accent border added (hover accent.hover from kit). Secondary: accent.subtle fill, accent text, border color-mix(accent 30%, subtle), hover color-mix(accent 15%, subtle); disabled neutral.100 / neutral.500 / neutral.200 border.
- Ghost hover accent.subtle; icon buttons accent colour + accent.subtle hover (rest stays white/neutral.200 per uix1); date-field calendar icon accent.
- a.lims-btn / a.lims-btn-primary: text-decoration none in rest/hover/focus-visible/visited (scoped .lims-shell).
- Focus: 2px focus-ring (accent alias), offset 1px on every .lims-btn [CONV kit :where ring]; sidebar (.lims-shell-nav) keeps its 3px accent-pop ring so it stays visible on the dark rail.
- [CONV] tint steps via color-mix: kit has no token between accent.subtle and accent (LD-444 "closest accent tint").
- Open: danger secondary not done (kit has no variant); disabled look only on secondary (others keep kit opacity 0.6); real-browser pixels unverified.
- Review fix 1: secondary/ghost/icon hover selectors now `:not([data-disabled], :disabled)`; native-disabled keeps neutral.100/500 on hover. Runs: uix6 131, uix1 63, uix5 100, ui kit 177 pass.
