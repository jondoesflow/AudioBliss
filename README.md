# AudioBliss

A pocket groovebox that runs in the browser. Program drums, percussion, bass, keys, leads and pads on a 16-step grid, set the tempo, record a live performance and save it as a WAV file. Built for phones first.

Everything is synthesised with the Web Audio API. There are no samples to download, so the page loads instantly and works offline once cached.

## Features

- **Step sequencer** with 1, 2 or 4 bar patterns, drag to paint steps, accent and ghost velocities, swing.
- **85 instruments** across drums, percussion, bass, keys, leads, pads and FX, all synthesised in code.
- **Melodic tracks** with a scale-aware note editor, note lengths, chord modes (octave, power, triad, 7th, 9th, sus), octave and transpose.
- **Key and scale** for the whole project. Change them and every melodic track follows.
- **BPM control** from 40 to 240 with hold-to-repeat buttons, a slider, tap tempo and genre presets.
- **Per-track mixing**: volume, tone, reverb send, tempo-synced delay send, pan, mute and solo.
- **17 genre grooves** as starting points: liquid drum & bass, a Bicep "Glue"-style breakbeat, deep house, boom bap, techno, trap, lo-fi, UK garage, dubstep, synthwave, afrobeats, reggaeton, ambient, jungle, dub, acid house and an empty kit.
- **Live pads** for playing a drum kit or any melodic track over the loop.
- **Record** the master output while you perform (mutes, pads, tempo changes all captured) and save the take as a 16-bit WAV.
- **Export** the pattern rendered offline, exactly on the grid, as 1, 2, 4 or 8 loops with the reverb tail.
- **Save** projects in the browser, or export and import them as JSON files.

## Running it

It is a static site. Open `index.html` from any web server, or push to the `main` branch and the included GitHub Actions workflow deploys it to GitHub Pages.

If the first Pages deployment fails, open the repository settings, choose **Pages**, and set the source to **GitHub Actions**, then re-run the workflow.

To try it locally:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

On iPhone, add the page to the Home Screen for a full-screen app. Audio starts after the first tap, which is a browser rule.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Markup and styles |
| `js/synth.js` | Instrument synthesis, scales, chords, master bus and effects |
| `js/presets.js` | Genre groove templates |
| `js/app.js` | Sequencer scheduler, UI, recording, WAV export, saving |
| `scripts/build-artifact.mjs` | Builds a single-file version with CSS and JS inlined |

## Saving audio

Recordings and exports are 44.1 kHz (recordings use the device's native sample rate) 16-bit stereo WAV files. On phones the Save button hands the file to the browser's download handler, and the Share button opens the system share sheet so you can send it to Files, AirDrop, a DAW or a chat.
