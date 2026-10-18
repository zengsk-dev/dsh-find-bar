# Changelog

## 1.0.1

- Fix highlight offset: the haystack was whitespace-normalised while the match
  offsets were applied to the raw text node, so matches inside code blocks (text
  nodes containing newlines or repeated spaces) were highlighted on the wrong
  characters — often one line above the real match.
- `debugMatches()` on the finder for tests and console debugging.

## 1.0.0

- First release: `Ctrl+F` / `Cmd+F` find bar in the `shell.overlay` slot,
  live search with an overlay highlight layer, `Enter` / `Shift+Enter` navigation,
  reactive counter and arrow states, `Esc` to close, rebindable `find.inPage`
  shortcut, zh/en copy, theme-token styling.
