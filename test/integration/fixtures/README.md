# Golden regression fixtures

`golden-frame.png` (not committed yet) is the reference frame
`test/integration/golden-render.test.ts` compares every render of
`examples/smoke` against, via `ffmpeg`'s `psnr` filter.

Generate it once, on a machine with a real `ffmpeg` + Chromium/
`chrome-headless-shell` toolchain (this repo's dev container/CI, not
necessarily your local machine):

```bash
npm run golden:update
```

That renders `examples/smoke`, extracts its first frame, and writes it here
as `golden-frame.png`. Commit the resulting PNG. From then on,
`golden-render.test.ts` fails the build if a future change to `hfmpeg`, the
pinned `@hyperframes/producer` version, or the pinned Chromium/FFmpeg build
visibly changes that frame's output.

Re-run `npm run golden:update` deliberately (and review the diff) whenever a
change is *expected* to alter rendered output — a quality/encoder change, a
`@hyperframes/producer` bump that touches rendering, etc.
