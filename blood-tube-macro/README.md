# Blood Tube Macro (HyperFrames)

A 5-second, 1080×1920 (9:16) macro shot: a gloved hand slowly lifts the center
red-cap vacuum blood-collection tube out of a stainless-steel rack. Deep red
blood swirls inside it, and the camera dollies in from a low angle while focus
pulls from the rack to the tube.

The whole shot is a deterministic Three.js scene inside a HyperFrames composition
(`index.html` + `scene.js`). Every frame is computed from HyperFrames time
(`hf-seek`), so renders are reproducible.

## What's in the frame

- **Tubes**: 13×100 mm glass vacuum tubes made with a transmissive physical
  material. Red ribbed caps sit over a rubber stopper. There are no labels and no text.
- **Blood**: an opaque deep-red fill with a glossy surface and a meniscus at the
  top. The hero tube has a slow procedural swirl that builds with lift speed, and its
  surface tilts against the hand's sway. The two tubes left in the rack stay calm.
- **Hand**: the WebXR generic right hand (`@webxr-input-profiles/assets`).
  Its joints are re-chained, posed into a thumb/index/middle pinch with
  `solvePinch()`, and smoothed with two levels of Phong-tessellated subdivision.
  It wears a blue nitrile glove material with a micro-texture.
- **Lens**: a 100 mm full-frame equivalent (20.4° vertical FOV) at f/5.6. A
  depth-of-field pass with a physical circle of confusion pulls focus from the
  near rack corner to the lifted tube between 0.9 s and 3.1 s.
- **Light**: a cool overhead area light and soft shadow key, plus warm rim
  spots behind. A PMREM lab environment provides the glass and steel reflections.
- **Finish**: bloom, ACES tone mapping, a cool-shadow/warm-highlight grade, a
  vignette, faint chromatic aberration and seeded film grain.

## Commands

```bash
npx hyperframes check          # lint + runtime/layout audit
npx hyperframes preview        # Studio preview
npx hyperframes render --quality delivery --fps 30 --workers 4 --output renders/blood-tube.mp4
```

All runtime dependencies are vendored under `assets/vendor/`: three r181,
its addons, and GSAP. The hand model is in `assets/models/`. Nothing is
fetched from a CDN at render time.
