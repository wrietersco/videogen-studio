# AI-designed intro / outro backgrounds

The title scene and the closing scene of a film no longer sit on a fixed drawn motif (graph / flow / cards).
The writer model designs the background for **this** film and codes it (canvas 2D / SVG / CSS / GSAP, three.js only
for tiny scenes because it is software-rasterised and slow here). The logo, label, headline and sub-line are laid
over it exactly as before.

## Flow

```
film (Record an app: appRecon/run.ts · Market: marketing/film.ts)
  └─ designFilmBackgrounds()                       introBg/film.ts
       ├─ title:  directBackground()               introBg/director.ts
       └─ outro:  directBackground({ family })     same family as the title, settled, ≤ 2 rounds
            each run:  library lookup → (adapt a close match) → write → lint → browser check of the art
                       → browser check of the scene with the text over it → model reviews its 4 frames
                       (score ≥ 7, title readable, not generic, belongs to the subject) → ≤ 3 fix rounds
            accepted (≥ 7) → saved in the library
  └─ renderScene({ background })                   appRecon/scenes.ts   (art in an <iframe srcdoc>, text layer over it)
  └─ the drawn motif only when no background could be made (and the notes say so)
```

Shared with the Market intro director (`marketing/agent/intro.ts`): `introBg/kit.ts` — page harness
(`introPage`: seeded `Math.random`, `W/H/DURATION`, GSAP, optional three.js import map, all offline), code lint
(`lintIntro`), and the browser check (`previewPage`: errors, flat/faint frames, no motion, too-slow frames,
words off the frame, missing words).

## Library

`Documents\VideoGen Studio\intro-backgrounds\` (dev: `<checkout>\intro-backgrounds`, git-ignored)

```
index.json                 every entry's meta
<id>/index.html            playable page (open it in a browser)
<id>/source.json           { html, css, js }
<id>/meta.json             topic, keywords, mood, palette, concept, model, score, aspects, size, durationSec, kind, usesThree, adaptedFrom, adaptedCount, createdAt
<id>/preview.jpg           one frame of the art
```

A close match (keyword overlap with the new film's topic, same kind) is handed to the model as a *starting point*; the
model must redesign it. A draft that is the stored code unchanged (or ≥ 90 % of its lines) is refused and sent back.
The closing scene gets the same treatment against the title scene's code.

## Revisions

A Record-an-app run keeps `intro-background-title.json` / `intro-background-outro.json` in its run folder and lists
them in `recording-record.json` (`introBackground`), so a changed film is re-rendered on the same art.

## Notes the person sees

* "The title scene's background was designed for this film: … (N rounds, the AI scored it x/10)."
* "No AI writer is set up, so the title and closing scenes use the drawn "graph" motif."
* "The AI could not design a background for this film (…), so the title and closing scenes use the drawn "graph" motif."
