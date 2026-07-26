# Final Image Generation Prompt Set

## Shared production prompt

Use case: `stylized-concept`. Asset type: production-ready animated desktop pet
sprite atlas for WorkBuddy. Produce crisp high-resolution pixel-art/cartoon
hybrid artwork with a bold dark-navy outline, flat colors, and strong readability
at 120–180 px.

The atlas must contain exactly eight equal columns by seven equal rows (56 cells),
with one consistent full-body character centered in every cell. Keep consistent
scale, baseline, markings, accessories, and proportions. Do not draw grid lines,
panels, borders, labels, numbers, logos, watermarks, shadows, or extra characters.

Rows, top to bottom:

1. `idle`: blue accent, breathing/bob, blink, tail or wing sway.
2. `thinking`: indigo accent, upward gaze, orbiting gear and dot sparks.
3. `working`: amber accent, focused keyboard/tablet/tool action.
4. `review`: teal accent, magnifying lens and page scan.
5. `waiting`: purple accent, alert pose, question mark, impatient motion.
6. `done`: green accent, happy hop, check badge and sparkles.
7. `failed`: red accent, slumped pose, X eyes and warning badge.

Use eight small sequential animation changes per row. Keep every prop within its
cell. Use a perfectly flat solid `#FF00FF` background with no texture, gradient,
reflection, floor, or lighting variation, and never use magenta in the character.

After chroma-key removal, run the deterministic frame repacker. Normalize the
detected source grid into `192 x 208` cells while preserving character aspect
ratio, assign disconnected artwork to its own frame, scale the wide-eared fox to
62% and the other pets to 70%, and require at least 16 fully transparent pixels
on every side of every runtime crop.

## Progressive slacking extension

Do not ask the image model to redraw the complete 11-row atlas. Generate only
the following locked masters, remove the `#FF00FF` chroma background, and use
`tools/build_slacking_atlases.py` to place and animate them on the existing
identity-aligned atlas:

1. One 4-by-2 sheet of eight consecutive fresh-fish frames, with a lively
   silver/cyan fish and a loop-closing tail motion.
2. One 4-by-2 sheet of eight consecutive salted-fish frames, with a tired pale
   blue-gray/muted-beige fish. This same sequence becomes row 10 in every pack.
3. For each pet, one precise identity-preserving edit of the canonical reference:
   dress the pet in the same pale blue-gray/muted-beige salted-fish one-piece
   costume, with a face opening, fin sleeves, and tail fin. Preserve the exact
   species, face, markings, accessories, proportions, pose scale, and bold navy
   outline. Return one full body only, no text, shadow, floor, or extra prop.

All masters use a perfectly flat solid `#FF00FF` background. The builder appends
four eight-frame rows (`slacking`, `slacking_salted`, `slacking_costume`, and
`slacking_shared_fish`) without resampling rows 0–6. It uses whole-pixel motion
around a fixed bottom-center anchor, so adding frames cannot introduce body-size
or bounding-box drift.

## Character prompts

### Pico Patch

An original compact orange fennec fox with huge triangular dark-navy-tipped ears,
a cream muzzle and belly, a navy utility bandana with one teal square patch, and
a fluffy cream-tipped tail. Cute, clever, and friendly.

### Bloop

An original compact sky-blue axolotl with a round head, three coral-orange gill
fronds on each side, pale cream belly, short legs, wide dark-navy eyes, a tiny
navy backpack, and one teal zipper tab. Cute, buoyant, and friendly.

### Olli Orbit

An original very round tawny-brown owl with a cream heart-shaped face disk,
dark-navy wing tips and feet, oversized teal square glasses, and a navy
cross-body satchel with one amber button. Cute, observant, and scholarly.

### Taro Tinker

An original compact golden-tan pangolin standing upright, with bold simplified
geometric scales, cream muzzle and belly, dark-navy claws and tail tip, a tiny
navy tool belt, and one teal wrist band. Cute, sturdy, and inventive.

### Nimbus Noodle

An original compact white cloud-like baby dragon with a bold smooth silhouette,
pale sky-blue belly, two short cobalt horns, dark-navy round eyes, small rounded
wings, a crescent-curled tail, and a navy collar with one teal star charm. Cute,
airy, and magical.

### Momo Mug

An original compact caramel-brown capybara with a cream muzzle, navy
neckerchief, and teal mug charm. Calm, cozy, and dependable.

### Kiki Koala

An original compact silver-gray koala with cream inner ears, a navy cross-body
pouch, and teal leaf clasp. Gentle, thoughtful, and sleepy-cute.

### Rumi Relay

An original charcoal-gray raccoon with a navy eye mask, striped tail, utility
vest, and teal pocket. Curious, nimble, and friendly.

### Pogo Ping

An original round navy-and-white penguin with orange beak and feet, teal bow
tie, and a small messenger pouch. Cheerful, precise, and energetic.

### Sora Shiba

An original golden-orange Shiba with cream markings, curled tail, navy bandana,
and teal tag. Loyal, alert, and optimistic.

### Nori Nibble

An original rust-red panda with cream face markings, striped tail, navy hoodie,
and teal zipper pull. Cozy, curious, and clever.

### Buzz Bit

An original round golden bumblebee with navy stripes, opaque pale-cyan wings, a
micro-backpack, and teal indicator. Bright, industrious, and friendly.

### Moss Shell

An original moss-green tortoise with a cream face, amber shell plates, navy
scarf, and teal leaf badge. Patient, grounded, and wise.

### Comet Lop

An original moon-white lop rabbit with long gray-tipped ears, navy scarf, and
teal crescent clasp. Quick, gentle, and imaginative.

### Gizmo Kernel

An original honey-gold hamster with cream cheeks, navy utility belt, and teal
seed buckle. Busy, cheerful, and resourceful.
