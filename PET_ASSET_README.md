# WorkBuddy Cartoon Pet Collection

Fifteen original WorkBuddy-compatible cartoon pets, each delivered as a two-file pack:

- `pico-patch` — orange fennec fox; quick, bright, and tool-oriented.
- `bloop` — sky-blue axolotl; buoyant and playful.
- `olli-orbit` — bespectacled round owl; calm and analytical.
- `taro-tinker` — golden pangolin; sturdy and inventive.
- `nimbus-noodle` — white cloud dragon; airy and celebratory.
- `momo-mug` — caramel capybara; calm and dependable.
- `kiki-koala` — silver koala; gentle and thoughtful.
- `rumi-relay` — charcoal raccoon; nimble and curious.
- `pogo-ping` — navy penguin; cheerful and precise.
- `sora-shiba` — golden Shiba; loyal and alert.
- `nori-nibble` — rust-red panda; cozy and clever.
- `buzz-bit` — golden bumblebee; bright and industrious.
- `moss-shell` — moss-green tortoise; patient and grounded.
- `comet-lop` — moon-white lop rabbit; gentle and imaginative.
- `gizmo-kernel` — honey-gold hamster; busy and resourceful.

Every `spritesheet.png` is a transparent `1536 x 2288` atlas arranged as eight
columns by eleven rows. Each frame is `192 x 208`. Rows 0–6 map to `idle`,
`thinking`, `working`, `review`, `waiting`, `done`, and `failed`. Rows 7–10 add
the progressive inactivity displays: fresh fish, salted fish, individual
salted-fish costume, and the same shared salted-fish form for all pets.

Each frame is isolated and aligned to a stable per-state bottom-center anchor.
The pet and any detached effects are moved together by whole pixels, so the art
is not resampled during position correction. Nine high-confidence undersized
outliers are uniformly normalized; pose-driven size changes are preserved. The
final atlases keep at least 16 transparent pixels between visible artwork and
every runtime crop edge, so ears, tails, props, and state symbols cannot leak
into neighboring frames.

The four added rows follow the same alignment contract. Their visible pixels
stay within a fixed per-pet bottom-center anchor and at least 24 transparent
pixels from each crop edge. They use eight deterministic frames derived from a
locked master, so identity, body scale, and baseline do not drift between frames.

## Install one pet

Copy the two files from the chosen directory into the WorkBuddy user-pet folder:

```text
~/.workbuddy-buddy/pet/
  pet.json
  spritesheet.png
```

Restart the pet after copying. Remove the user-pet folder to return to the
built-in pet.

## Design system

The series uses bold navy silhouettes and a shared state language: blue idle,
indigo thinking, amber working, teal review, purple waiting, green done, and red
failed. Props and expressions reinforce the color signals so the state remains
readable without relying on color alone.

The characters are original and were generated with the built-in image
generation workflow, then converted from a flat chroma-key background to alpha
and normalized to the WorkBuddy grid. Shared fish motion and one costume master
per pet are composed deterministically; the full character is not independently
redrawn for every frame. `tools/repack_sprites.py` performs the
deterministic per-frame component separation and safe-spacing pass.
`tools/align_sprite_frames.py` performs the cross-frame motion alignment, and
`tools/render_motion_preview.py` renders all states for visual QA. See
`PROMPTS.md` for the reusable prompt specification.
