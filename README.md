# Fire Cursor 🔥

A living ring of fire that follows your pointer. It's simulated in WebGL2, not animated, so the flames never repeat.

It comes as two small files with no dependencies and no images: the fire cursor, and an optional smoke effect. You add each one with a single line.

- **Real flame simulation.** Heat rises, swirls around the ring and cools unevenly, so flames lick, split and die naturally.
- **Flame trails.** Moving the pointer leaves genuine trails of fire that cool behind it.
- **Embers.** Glowing sparks drift off the ring, with more when you move fast.
- **Edge flames.** Hover a button, link or card and its outline catches small flames near the cursor.
- **Liquid glass, optional.** Glass elements reflect the flames and embers live as the fire moves.
- **Smoke hover, optional.** Sweep across a button, card or title and it dissolves into real flowing smoke along your path, then heals. Titles even lose their letters to the smoke.
- **Magnetic float.** With the smoke file, hovered elements lean a few pixels toward the cursor.
- **Light and dark.** It reads the page background and adapts automatically.
- **Light on resources.** It runs at your display's refresh rate (120 fps on 120 Hz screens) and sleeps completely when the pointer leaves the page.

Built by [Harshil Acharya](https://www.instagram.com/harshil_designer/).

---

## Quick start

Add the script, then start it:

```html
<script src="fire-cursor.js"></script>
<script>
  FireCursor.init();
</script>
```

That's it. Open `index.html` in this repo for a live demo with a theme toggle and sliders.

### Add the smoke

```html
<script src="smoke-hover.js"></script>
<script>
  SmokeHover.init();
</script>
```

Fire and smoke are independent, so you can use either one on its own or both together.

> Serve the page over `http://` or `https://` (a local server is fine). Opening it straight from the file system also works, but some browsers limit WebGL on `file://` pages.

### With a bundler

```js
const FireCursor = require('./fire-cursor.js');   // or import it with your bundler
const fire = FireCursor.init({ radius: 14 });
```

---

## Liquid glass

Add `glass.css` and give any element the `fc-glass` class:

```html
<link rel="stylesheet" href="glass.css">

<div class="card fc-glass">…</div>
<button class="fc-glass">Send</button>
```

- **At rest**, `glass.css` adds a soft gloss and sheen. It only adds background layers, so the element keeps its own border, fill and focus ring.
- **Near the fire**, `fire-cursor.js` draws the glass effects live: reflections of the flames, a thin glowing edge on the side nearest the fire, a warm glow, and reflections of the embers.
- **Shadow**, if you want one: add `fc-glass--lifted` to cards for a soft drop shadow.

Turn the glass effect off with `glassSelector: ''`, or adjust it with `glassStrength`.

---

## Fire options

```js
FireCursor.init({
  radius: 13,               // size of the fire ring, in CSS px
  embers: 160,              // max embers on screen (0 = none)
  edgeSelector: 'a, button, [role="button"], input, textarea, select, [data-fire-edge], .fc-glass',
                            // hovered elements whose outline catches flames
  growSelector: 'a, button, [role="button"], [data-fire-grow]',
                            // the ring grows slightly over these
  glassSelector: '.fc-glass', // elements that reflect the fire ('' = off)
  glassStrength: 0.25,      // 0 – 1, how strongly glass picks up the firelight
  hideCursor: true,         // hide the system cursor while the fire runs
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  zIndex: 2147483000,
  respectReducedMotion: true  // keep the normal cursor for people who prefer reduced motion
});
```

**Tip:** to give any element edge flames without changing your selectors, add `data-fire-edge` to it.

## Smoke options

```js
SmokeHover.init({
  selector: 'button, a, input, textarea, select, [role="button"], h1, h2, h3, [data-smoke], [data-smoke-text]',
                            // elements that turn to smoke as the cursor sweeps over them
  textSelector: 'h1, h2, h3, [data-smoke-text]',
                            // titles: the letters themselves bend and dissolve
  float: true,              // hovered elements lean a few px toward the cursor
  density: 1,               // how much smoke is released (0.3 – 1.5)
  linger: 1,                // how long the smoke lasts (0.5 – 2)
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  lightSmoke: [.07, .07, .08], darkSmoke: [.93, .93, .95]   // smoke colours (RGB, 0–1)
});
```

**Tip:** add `data-smoke` to any card or panel you want to smoke. The empty background never smokes.

## API

`FireCursor.init()` returns a controller:

```js
const fire = FireCursor.init();

fire.running;               // false if the effect couldn't start (see below)
fire.setTheme('dark');      // 'light' | 'dark' | 'auto'
fire.setGlassStrength(0.5);
fire.destroy();             // removes everything and restores the normal cursor

const smoke = SmokeHover.init();
smoke.setTheme('light');
smoke.destroy();
```

---

## Phones and tablets

On touch screens there's no cursor, so the fire follows your finger while it's on the screen, and dragging across an element smokes it. Scrolling still works normally. Turn this off with `touch: false` on either effect.

To make sure phone visitors still see something, you can steer both effects yourself with `drive(x, y)` and hand control back with `release()`. The demo page uses this to write the fire across the headline whenever nobody is touching the screen:

```js
const fire = FireCursor.init(), smoke = SmokeHover.init();
let t = 0;
(function autoplay() {
  t += 0.016;
  const r = document.querySelector('h1').getBoundingClientRect();
  const x = r.left + r.width * (0.5 + 0.44 * Math.sin(t * 0.62));
  const y = r.top + r.height * (0.5 + 0.36 * Math.sin(t * 1.24));
  fire.drive(x, y); smoke.drive(x, y);
  requestAnimationFrame(autoplay);
})();
// a real mouse or finger always takes over from drive()
```

## When it doesn't run

The effect turns itself off, and your normal cursor stays, in these cases:

- **Reduced motion.** The user has turned on "reduce motion" in their system settings (you can change this with `respectReducedMotion`).
- **No WebGL2.** The browser doesn't support WebGL2 with float textures. All current versions of Chrome, Edge, Firefox and Safari do.

## How it works

1. **The heat field.** A heat texture covers the viewport, slightly lower resolution than the screen. Every frame, the heat:
   - moves with rising air, a swirl around the ring and the pointer's wake;
   - cools at a rate that varies across the screen and over time;
   - is fed by a ragged, breathing ring of heat around the pointer, with two brighter arcs that slowly circle.
2. **Display.** A second pass turns heat into fire colours, from deep red tips through orange and yellow to a near-white core. It adds fine rising streaks and a faint heat shimmer.
3. **Embers.** Embers are simple particles drawn as glowing points.
4. **Glass.** For glass elements near the pointer, the display pass also draws the fire's reflections. The fire is the only light source, so the reflections follow it frame by frame.
5. **Smoke.** A ribbon of smoke strands, generated in code, is laid along the cursor's path whenever it moves over an element. A GPU fluid solver ("stable fluids") then makes it curl, swirl and rise. The element underneath gives way along the smoke's own contours, its outline or letters bend with the flow, and everything heals a moment after you stop.

All the shader code is in `fire-cursor.js` and `smoke-hover.js`, and it's commented, so it's a good place to start experimenting with colours, flame height or the ring shape.

## License

[MIT](LICENSE). Use it freely in personal and commercial projects. A credit or a tag is always appreciated ✨
