# ra11y demo tape — declarative VHS script.
#
# Renders to docs/demo.gif via:  vhs docs/demo.tape
#
# Demonstrates `bunx ra11y` against the canonical bad fixtures the README
# already cites (alt-text-missing/img-no-alt.html and contrast-minimum/
# low-contrast.css), so the GIF and the README's static code-block stay in
# visual sync.
#
# CI regenerates the GIF on changes to this tape or to scanner output —
# see .github/workflows/vhs.yml. Locally, install once with `brew install
# vhs` (pulls ttyd + ffmpeg) and re-run the command above.
#
# Tuning notes:
#  - FontSize 18 + Width 1200 reads cleanly on both README desktop and
#    npm.js detail pages without horizontal scroll.
#  - Height 700 fits the canonical fixture output (two file groups +
#    summary line + coverage line) without trailing whitespace.
#  - TypingSpeed 60ms is brisk but legible; raise if recording for a
#    slower-paced audience.
#  - PlaybackSpeed 1.0 keeps the actual scan duration honest — sub-second
#    finish is part of the pitch.

Output docs/demo.gif

Set FontSize 18
Set Width 1200
Set Height 700
Set TypingSpeed 60ms
Set Theme "Catppuccin Mocha"
Set Padding 20

# Establish the prompt before typing.
Sleep 500ms

Type "bunx ra11y tests/fixtures/bad/alt-text-missing tests/fixtures/bad/contrast-minimum"
Sleep 800ms
Enter

# Hold on the scan output long enough to read the WCAG citations and
# fix suggestions — this is the moment the GIF earns its keep.
Sleep 6s
