# The Lost Formulas in the browser: hand-off notes

Written for an AI agent (or person) picking this project up cold. Read this first; it should save days.

## 1. What this is

"M&M's: The Lost Formulas" (Boston Animation / Simon & Schuster Interactive, 2000, Windows) runs in a web browser
by **static recompilation**. The original `MnMs.exe` machine code is translated ahead of time into JavaScript and
linked against a small re-implementation of the Win32, OpenGL 1.1, DirectSound and MCI calls the game makes.
The user supplies their own copy of the game files through a folder picker. No game data is embedded in the page;
only the translated exe code and the exe's data sections are.

Deliverables:

| File | What it is |
|---|---|
| `dist/lost-formulas-play.html` | The playable page (about 13 MB, single file). |
| `dist/lost-formulas-viewer.html` | Asset viewer: opens .GRP models, .OFF levels, .LEV scripts directly in WebGL (three.js r128 from cdnjs). |
| `recomp/` | Translator, runtime, host layer, WebGL layer, front end, build script, test harnesses. |
| `tools/` | Python format parsers (LZSS, GRP), the viewer sources, exe cross-reference script. |
| `ghidra/` | Headless export script, labels for dynamically imported functions, function list, full decompiled C (`mnms.c`). |

Status at hand-off (v1.3): boots, menus work, player creation and saving work (verified across a page reload),
Level 1 (jeep) and Level 2 (on foot) load, render and respond to input in Chromium, the MATH difficulty screen works.
Sound effects and MIDI music are wired up and follow the game's own volume settings. Cutscenes are decoded from the
original .bik files in the browser (section 5a). The page finds the game files next to itself and boots with no
prompt (section 5b). Levels 3 to 8 and the in-level math challenges have not been exercised.

Why this approach and not a rewrite: the decompile showed hundreds of interlocking gameplay functions, a
message-passing actor system and hand-written per-level logic. A rewrite would never match. Translation carries over
everything (menus, math mode, cheats, all levels) unchanged. Emulating Windows 98 in the browser (DosWasmX, js-dos)
was unplayably slow because the guest had no 3D acceleration and the game fell back to software OpenGL.

## 2. How to rebuild

Needs: Python 3 with `capstone`, `pefile` (and `unicorn` for the differential test), Node 18+, and for browser tests
Playwright with Chromium. The user's `MnMs.exe` is NOT in this bundle.

```
cd recomp
python3 make_image.py /path/to/MnMs.exe      # writes image.bin + meta.json
python3 lift.py /path/to/MnMs.exe blocks.js  # ~3 min, ~12.8 MB of JS  (optional 3rd arg: file of extra hex entry points)
python3 build_web.py                         # edit the output path at the bottom; produces the single-file page
```

Lifter knobs (environment): `LF_MAXTRACE` (default 40), `LF_FOLLOWCALL` (default 0). See section 6 for why.

Node harness (headless, GL stubbed, deterministic virtual clock of 16 ms per SwapBuffers):

```
# put game files under recomp/gamefs/ mirroring the CD: gamefs/setup.cfg, gamefs/DATA/...   (set G_Renderer 1)
FRAMES=2200 KEYSCRIPT="60:39:333,120:13:28,..." node main_node.js
#   KEYSCRIPT entries are frame:virtualKey:scancode[:char]; add 256 to the scancode for extended keys (arrows).
#   TRACE=1 logs file opens and API call counts; BLOCKS=otherfile.js picks a different translation; BUDGET caps blocks.
```

Menu sequence that creates a player and starts the game: Right, Enter, type a name, Enter, Enter, Up, Enter.
As a KEYSCRIPT: `60:39:333,120:13:28,180:66:48:66,200:79:24:79,220:66:48:66,300:13:28,420:13:28,560:38:328,650:13:28`.

Browser test: `python3 webtest2.py '<json steps>'`. Steps: `["frames",n]`, `["key","Enter"]`, `["type","BOB"]`,
`["hold","ArrowUp",ms]`, `["shot","file.png"]`, `["eval","js"]`. Headless Chromium uses SwiftShader and runs the
game at about 5 fps, so ALWAYS wait on frame counts, never milliseconds. Page hooks: `__addRaw(entries)`,
`__start()`, `__state()`, and `__dbg` (`r32,w32,r16,w16,u8,rf32,wf32,gstr,regs(),setLevel(n)`).
`__dbg.setLevel(2)` just before pressing Enter on PLAY jumps straight to a level.

## 3. The executable

- PE32, Visual C++ 6, not packed or protected. Image base `0x400000`, entry `0x45350a`.
  `.text` = `0x401000`..`0x458000`; the static C runtime sits from about `0x450000` up. About 590 functions.
- Static imports: 104 functions from KERNEL32, USER32, GDI32, WINMM only.
- Loaded at run time with LoadLibrary/GetProcAddress:
  - `opengl32.dll` + `glu32.dll` (or 3dfx MiniGL names). Quake-style loader resolves ~360 names, but only **37 GL
    functions + gluBuild2DMipmaps** are ever called (list in `host.js`).
  - `glide3x.dll` (native Glide 3 renderer), `ddraw` (Direct3D 7 through COM), `dsound.dll`, `binkw32.dll`.
  - If binkw32 or dsound is missing the game carries on (no videos / no sound).
- `setup.cfg`: `G_Renderer` 0 = Glide, **1 = OpenGL** (2 presumably Direct3D, unverified). The page forces 1 and
  windowed mode. `G_CheatEnable 1` and a commented `G_DataPath` exist.
- **Rendering model**: the game does its own transform, clipping and lighting on the CPU. It calls `glOrtho` once and
  submits screen-space triangles in immediate mode: `glBegin/glVertex3f/glTexCoord4fv/glColor4ub/glEnd`.
  The q component of `glTexCoord4fv` gives perspective-correct texturing, so the shader must divide s,t by q.
- **Disc check** (`FUN_004097b0`, called from WinMain `FUN_0044e120`): data path = `G_DataPath` or current directory;
  `GetDriveTypeA` must return 5 (CD-ROM), `SetFileAttributesA` must FAIL (read-only media), and
  `DATA\ROBOTS\YELLOW.GRP` must be found with FindFirstFile. Solved by making the current directory `D:\`, a virtual
  CD whose SetFileAttributes fails. (Bypass flag `DAT_00481d34` exists but was not needed.)
- **Window procedure** `FUN_004087c0`: key code = `scancode | (extended << 7)`, i.e. DirectInput-style numbers
  (203 = left arrow). WM_CHAR (0x102) is used for name entry. 0x3B9 (MM_MCINOTIFY) restarts music. Mouse messages
  0x200..0x205 are only recorded (see "Mouse" below).
- Landmarks: level loader `FUN_00448d60` (installs per-level callbacks at its end); main-actor message handler
  `FUN_00440630` (msg 8 = set position, 0x50 = die, 0x2000 = tick); joystick init `FUN_0044d5e0`, poll
  `FUN_00414180` (probed ONLY at start-up, thresholds at 1/8 and 7/8 of the axis range); mixer volume
  `FUN_00434d10`; DirectSound init near `0x438080`.
- Globals: `0x486f68` level number (1-based); `0x4879ec` level part; `0x4834a8` mode (2 = in-level adventure);
  `0x481ecc` pointer to current player record (`+0x100` level index 0-based, `+0x104` mode); `0x4863ec` main actor
  (position at `+0x10`).
- Files: model search order is `DATA\LEVELxx`, then `DATA\ROBOTS`, then `DATA\GROUPS` (so "not found" in the first two
  is normal). Writes `LOG.TXT`, `PLAYERS.LST` (3,212 bytes), `setup.cfg`. Music `DATA\music\L%02dP%01d.mid`,
  `music00.mid`. Videos `LEVEL%02d%c.BIK` in CINEHIGH/CINELOW.
- **Saving**: load = `FUN_0042c030` (start-up), save = `FUN_0042c230`, called from the player menu
  (`FUN_0042d360`), from in-game code (`FUN_0044a320`, `FUN_0044af50`) and at shutdown (`FUN_0044dd60`).
  The game does NOT write `PLAYERS.LST` at the moment a player is created; the first write comes when the player
  screen is confirmed again or on an in-game save event. The page persists `PLAYERS.LST` and `SETUP.CFG` to
  localStorage whenever the game closes a written file; browser storage takes priority over a copy in the chosen
  folder. Verified end to end in Chromium: create player, trigger a save, reload the page, player still listed.
- **Main menu navigation is spatial**: after the player screen the highlight is on PLAYER. Up = PLAY,
  Down = EXIT, from EXIT Left = MATH and Right = OPTIONS, LEVEL is left/up of MATH.
- **Mouse**: the window procedure records mouse position and buttons, but no menu or gameplay code reads the
  position (only the built-in level editor paths do). Forwarding the mouse is not worth doing.
- **Volumes**: `VOLUME_SFX` and `VOLUME_MIDI` are applied through the Windows mixer API (`FUN_00434d10` for the
  wave-out line 0x1008, `FUN_00434380` for the synthesizer line 0x1004), i.e. the original changed the SYSTEM
  volume. `host.js` implements a tiny mixer (line ids 0x100 wave, 0x101 synth) and forwards to `PLAT.setVolume`.
- **Sound formats**: DirectSound buffers carry their own WAVEFORMATEX, so the play page never guesses a sample
  rate (only the asset viewer assumes 22,050 Hz).
- **Video playback loop** `FUN_004261e0`: `BinkSetSoundSystem`, `BinkOpen(name,0)`; then a BUSY loop that pumps
  messages, polls the joystick, exits on any key, spins while `BinkWait` is non-zero, else calls a per-renderer
  frame routine (OpenGL: `FUN_00424790` = BinkDoFrame, BinkNextFrame, BinkCopyToBuffer, draw, swap) which returns
  false when its own frame counter reaches `bink->Frames`. If Width > 400 it decodes two frames per displayed frame.
  BINK fields used: [0] Width, [1] Height, [2] Frames, [3] FrameNum, [8] flags. Files: `LOGO0.BIK`, `LOGO1.BIK`,
  `CREDITS.BIK`, `LEVEL%02d%c.BIK` under `DATA\CINELOW` or `DATA\CINEHIGH` (chosen by `G_BinkHi`).

## 4. Data formats (little-endian)

**LZSS**: classic Okumura. 4096-byte ring, zero-filled, write position starts at 4078; max match 18, threshold 2;
flag bits read LSB first, 1 = literal; match = 2 bytes, offset = b0 | (b1 & 0xF0) << 4, length = (b1 & 0x0F) + 3.

**GRPC**: `"GRPC"`, u32 unpacked size, u32 packed size, LZSS data; unpacks to GRP1. Some files are plain GRP1.

**GRP1** header: magic, 0, size, then (count, offset) pairs for textures, meshes, animations, sounds.
- Texture entry 0x58: name[20] at +4; w +0x1C; h +0x20; format +0x24 (`0x888` RGB, `0x8888` RGBA); bytes per frame
  +0x28; frame count +0x30; data offset +0x54. Pixels are **BGR(A), bottom-up** (OpenGL row order).
- Mesh entry 0x2C: u16 faces +4, verts +6, frames +8, UVs +0xA; u32 face/UV/vertex/bbox offsets at +0xC..+0x18;
  u16 texture index at +0x1E (`0xFFFF` = per face).
- Faces: stride = (uvOff - faceOff) / nFaces. 12 = v[3], uv[3] (u16). 16 = + flags, texture index.
  36 = + three RGBA vertex colours at +16 (baked lighting; levels use this) + 8 bytes.
- Vertices: float xyz x nVerts x nFrames (morph-target animation, MD2 style). World is **Z-up**. UVs: float pairs.
- Animation entry 36 bytes: name[24], first frame, last frame, float fps. Yellow: STAND 237, RUN 238-249, JUMP1-4,
  DEATH1-2, ATTACK 0-7 (mesh 2), BREATH, LOOK, SHADOW. Which mesh an animation belongs to is not encoded explicitly.
- Sound entry 0x30: name[24], float audible range, u32 loop, ..., data offset at +44. Raw 16-bit signed mono PCM,
  22,050 Hz assumed (unverified). Length = next entry's offset (or the sound table offset) minus this offset.

**OFFC** (level geometry): header same shape. Texture entries 0x30: id, name[16], w, h, alpha marker (`0x8888`),
frame count, animation rate, packed size, offset. Each texture is LZSS-packed on its own; mesh data is not packed.
Level 1 part 1: 24,191 triangles, 342 textures, one huge sky-dome polygon.

**LEV** (level script): chunks of name[16], size, data offset (= chunk start + 32), record size, count.
START LOCATION (xyz floats + 12 bytes); LEVEL CAMERA (0x44-byte records, looks like a rail camera);
LEVEL FACEFLAGS (10 bytes per level triangle, probably collision/surface); LEVEL OBJECTS (variable);
ACTORS LIST; LEVEL TRIGGERS; RECOVER INFO; LEVEL ZONES (0x28); TEXTPLANES LIST (0x78); EFFECTS LIST (0x7C).
Actor record = 216 bytes + 60 bytes per path key; u16 key count at +0xC4; name +0; position +16; u16 angle +28
(65536 = full turn); model group name +0x54. Level 1 part 1 has 564 actors, 41 groups, 112 with paths.

**.lst** sound banks: small header then 0x30-byte entries pointing at raw PCM (same sample format).
**.PFF** particle definitions: not decoded.

## 5. Architecture of the play page

- `lift.py` -> `blocks.js`: one JS function per translated entry point, `function b4012a0(){...; return nextPc;}`,
  plus table `T[pc - TB]`.
- `runtime.js`: 512 MB ArrayBuffer addressed directly by guest addresses; typed-array views; registers, flags and
  x87 state as plain variables; string-op helpers; `run(pc)` trampoline; `callGuest(addr,args)` for host-to-guest
  callbacks (window procedure).
- `host.js`: Win32/WGL/WINMM/GL/DirectSound. `def(name, nargs, fn)`; nargs is the stdcall argument count in dwords
  (`-1` = cdecl, used by `wsprintfA`; doubles count as 2, e.g. `glOrtho` = 12). `makeCom()` builds COM objects in
  guest memory whose vtable slots are host-call addresses. Platform services come from a `PLAT` object.
- `webgl.js`: the 37 GL calls on WebGL 2 with batching (flush on any state change), client-side matrix stack,
  texture format conversion to RGBA8, alpha test and texture environment in the shader.
- `main_web.js`: folder picker -> in-memory virtual file system (skips .bik/.exe/.dll), keyboard -> WM_KEY/WM_CHAR
  with correct scancodes, gamepad -> joystick API, Web Audio backend, MIDI through webaudio-tinysynth 1.1.3
  (Apache-2.0, inlined), localStorage saves, requestAnimationFrame loop, debugging hooks.
- Memory map: image at `0x400000`; scratch `0x7fd000`; fake thread information block `0x7fe000` (for `fs:`);
  heap `0x1000000`..`0x1f000000` (size classes for small blocks, first-fit with coalescing above 4 KB);
  stack just under `0x1ff00000`.
- Control flow: a negative pc is a host call (import table and GetProcAddress hand out `0x80000000 + id*4`).
  `SwapBuffers` sets `yieldFlag`; each animation frame runs the guest until the next swap. Because all CPU state
  lives in variables and the x86 stack lives in guest memory, execution can stop between any two blocks.
  Host-to-guest callbacks push a sentinel return address and must not yield.

## 5a. Cutscenes: the .bik files are decoded in the browser (v1.3)

`host.js` still implements the Bink API itself (fake BINK struct, 320x240 so the game takes the one-frame-per-call
path, 15 fps, frame count from the media duration; `BinkWait` yields; `BinkCopyToBuffer` does nothing and the game
draws a black quad under the overlay). What changed is where the picture comes from:
- `main_web.js` reads the real `.bik` through `readAside()` (works in every source mode), then transcodes it to WebM
  with **ffmpeg.wasm**, whose default build includes the `binkvideo`, `binkaudio_rdft` and `binkaudio_dct` decoders.
  The result is cached in IndexedDB (store `videos`, key `STEM:bytelength`), so each viewer pays once. A
  pre-converted `.webm`/`.mp4` the user supplies is still used directly if present.
- The core is fetched by the PAGE (`ffCore()`), not by the worker: the JS as text and the wasm as an ArrayBuffer,
  then handed to the worker as `coreJS` + `wasmBinary`. This was necessary: importScripts enforces a JavaScript MIME
  type, and `locateFile` did not reach the core's wasm lookup when the script was imported from a blob URL.
- The core's API is `core.setLogger(fn)`, `core.setTimeout(-1)`, `core.FS.writeFile/readFile/unlink`,
  `core.exec(...args)`, `core.reset()`. There is **no** `callMain` in @ffmpeg/core 0.12.
- Core URL order: `?ffmpeg=` in the address, then `ffmpeg-core.js` next to the game files, then
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js`. Get a local copy with
  `npm pack @ffmpeg/core@0.12.10` (32 MB wasm; it is NOT in this bundle).
- Encode line: `-c:v libvpx -deadline realtime -cpu-used 8 -b:v 1500k -c:a libopus -b:a 96k -f webm`.
  Progress comes from parsing `frame=` in the decoder log.
- Tested end to end with stand-in files (AVI/mpeg4 renamed to .BIK, which exercises everything but the Bink decoder
  itself): 6 s clip 1.6 s, 25 s clip 6.6 s, both played in sequence and the game carried on.
  **Not yet tested with a real .bik** - no sample was available in the sandbox. If one fails, the Advanced panel logs
  the exact ffmpeg error.
- Translating `binkw32.dll` is still possible (its `.text` is 188 KB, needs threads, relocation off 0x10000000 and
  streaming DirectSound buffers) but there is now no reason to.

## 5b. Disc-image mode (part of the main page since v1.2)

Since v1.3 the page first looks for the game NEXT TO ITSELF and boots with no prompt: `autoStart()` probes
`DATA/ROBOTS/YELLOW.GRP` under `./`, `game/` and `cd/` (or `?game=<base>`), then `game.iso` / `lost-formulas.iso`
in the same places, then `?iso=<url>`. Only if all of that fails does the picker appear (Advanced opens itself).
`file:` pages skip the probe, because fetch is blocked there.
Web-folder mode needs no manifest: `filelist.js` embeds the retail CD's 365 file names (parsed from the user's
`tree /f` listing, original capitalisation preserved, which matters on case-sensitive hosts), and that list answers
`listDir`/`FindFirstFile`. Files are fetched per request through the same RETRY path, with the rest of the directory
prefetched behind them (queue, 6 in flight, urgent file jumps the queue).
The other ways in are unchanged: choose the game's `.iso` (read locally through `File.slice`), choose an unpacked
folder, or stream an ISO from a web address by HTTP range requests. All three feed the same virtual file system; the two ISO paths share one code path.
**archive.org was tried and does NOT work**: the user confirmed its download endpoint refuses cross-origin reads, so
there is no default address. Streaming needs a host that sends `Access-Control-Allow-Origin` and honours `Range`
(any ordinary static host or object store configured for CORS; `rangeserver.py` is a minimal reference), and it cannot
work from the published Claude artifact, whose content-security policy blocks requests to other sites.
- `iso.js`: volume descriptors at sector 16, prefers the Joliet tree, walks all directories through a 1 MB block cache
  (the whole index cost one 1 MB request on the test image), builds `path -> {offset,size}`. `fetchFiles` merges
  neighbouring files into spans (gap <= 512 KB, span <= 16 MB, 3 in parallel, 3 tries each).
- Start-up downloads `DATA\BASEDATA, SOUND, ROBOTS, GROUPS, MUSIC` (about 26 MB), then boots. Any other directory is
  fetched the first time the game opens a file in it: `CreateFileA` asks `PLAT.pending(name)` and returns `RETRY`
  until the directory has arrived (the game simply stalls on its loading screen). `FindFirstFileA` and `listDir`
  answer from the disc index (`PLAT.fileSize`), so the game's start-up scan for level files needs no downloads.
- Fetched directories are stored in IndexedDB (`lostformulas-disc`, key = image URL + directory). Verified: after a
  reload only the 1 MB index is downloaded again. `.BIK/.EXE/.DLL` are never fetched.
- The game root is found by locating `...\DATA\ROBOTS\YELLOW.GRP`, so the game may sit in a sub-folder of the disc.
- A plain 200 response to a Range request is aborted at once (so nobody downloads 613 MB by accident).
- Tested end to end against a local CORS + Range server (`rangeserver.py`, which also serves sub-paths and correct
  MIME types; `webtest_site.py` drives a hosted page) both as an ISO made by `mkiso.py` and as a plain directory of
  game files next to the page: boot with no prompt, player creation, lazy Level 1 load, gameplay, cache hit after reload. Chromium sent NO
  preflight for the `Range` header (it is CORS-safelisted), so archive.org only needs to send
  `Access-Control-Allow-Origin` on the final (redirected) response and honour Range.
- The user confirmed the real Mac/PC hybrid ISO from archive.org parses and plays through the local-.iso button.
- If streaming from a host without CORS is ever wanted, a small relay (for example a Cloudflare Worker forwarding
  Range requests) would do it; that relay then carries the game data.

## 5c. The page itself (v1.3)

`shell.html` is deliberately bare: the 4:3 `#stage` (canvas + `#overlay` progress text + any `.cine` video), a
`#bar` with Fullscreen, and one `<details id="adv">` holding everything else - frame-rate readout `#status`, the
`.iso`/folder/URL pickers `#picker`, "clear cached game data and videos", "clear saved players and settings", the
control list and the message log. `busy(msg)` drives the overlay, `fail(msg)` reveals the picker and opens Advanced.
Keep those element ids if you rewrite the shell; `main_web.js` looks them all up by id.

## 6. Translator design and the traps in it

- Discovery: recursive descent from the PE entry, every 4-aligned dword in the image that points into `.text`,
  every immediate that points into `.text`, jump-table entries, and the address after every `call`.
- Traces are multi-exit: `jcc` becomes `if(cond) return target;` and lifting continues; direct `jmp` is followed;
  a trace ends at call, ret, indirect jump, a revisited address, or `MAXTRACE` instructions.
  **Any address a trace returns because of the length cap must itself be translated** (the `continuations`
  worklist in `emit`). Forgetting this gives "jump to untranslated address".
- Following direct calls inside traces produced 17-19 MB of output and was slower. It is off.
  Published pages are limited to 16 MB, so watch output size when changing the lifter.
- Flags: `fr` holds the sign-extended result (ZF, SF, PF derive from it), `cf` and `of` are booleans. 8- and 16-bit
  operands are sign-extended to 32 bits, which keeps signed and unsigned comparisons and carry/overflow formulas
  valid. Flag assignments are wrapped in `@C( @O( @R(` markers and stripped by a backward liveness pass inside each
  trace; flags are treated as live at every exit. `inc/dec` do not define CF; shifts define flags only when the
  count is non-zero, so they never kill liveness.
- x87 is decoded by hand from opcode bytes D8..DF, because capstone's operand forms are ambiguous for the reversed
  sub/div encodings. JS doubles match VC6's 53-bit precision setting. `fistp`/`frndint` honour the rounding bits
  in `fcw` (the CRT's `_ftol` switches to truncation and back).
- 32-bit and float memory accesses are inlined with an alignment test; unaligned accesses fall back to helpers
  (packed file structures do produce unaligned accesses).
- Speed notes: wrap everything in one function (an IIFE) so state variables are closure slots, not script globals.
  In profiling, a Proxy-based GL stub and reading 12 arguments per host call completely hid translator gains.
  Level 1 costs about 8 ms per frame of translated code on a slow sandbox core (was 13.8 ms at first).

## 7. Tests that exist

- `dt2_gen.py` -> `dt2_run.js` -> `dt2_cmp.py`: differential test against Unicorn from identical random state
  (registers pointing into a scratch region, 8 random doubles on the x87 stack). Compares registers, CF/ZF/SF/OF
  when the last flag writer has defined flags, the x87 stack, a CRC of memory, and the next pc.
  Last results: 12,000 single blocks, 0 real mismatches (v1); ~1,000 traces, 0 mismatches (traces + flag pass).
  It was not rerun on the exact final configuration (MAXTRACE 40, inlined memory access).
  Tester artefacts to know about: Unicorn counts each `rep` iteration as an instruction; the TOP field it reports in
  `fnstsw` differs; a trace that returns at a loop back-edge is ambiguous (skipped); `idiv` overflow differs;
  Python's JSON writes NaN, which JS cannot parse.
- A/B behaviour test: the Node harness is deterministic, so per-function GL call totals over a scripted run must be
  identical between translator versions. The v1 translation, the trace version and a MAXTRACE-28 build matched over
  2,200 frames (13.4 million vertices). The shipped MAXTRACE-40 build was checked by playing to Level 2 in Chromium.

## 8. Pitfalls already solved (do not rediscover)

1. `mixerGetLineInfoA` must zero `cConnections`, or `FUN_00434d10` loops forever on stack garbage.
2. The CRT fetches `IsProcessorFeaturePresent` through GetProcAddress at start-up.
3. 128 MB of guest memory ran out while loading a level; a no-reuse allocator made it worse.
4. GL's default minification filter needs mipmaps; textures default to "wants mipmaps" and are generated lazily.
5. Interface IDs compare as little-endian bytes: `84fa9a27...` = IDirectSound3DListener (queried on the PRIMARY
   buffer), `86fa9a27...` = IDirectSound3DBuffer. DirectSound init fails if the listener query fails.
6. DirectSound is left-handed; Web Audio is right-handed: negate z. Positions are scaled by the distance factor
   the game sets (0.01).
7. Browsers may refuse to pick a drive root; tell users to copy the CD into a folder.
8. The always-present virtual joystick is deliberate: the game only looks for one at start-up, and browser gamepads
   appear only after a button press.
9. The game clock advances at most 100 ms per frame so a hidden tab does not cause a huge time step.

## 9. Open work, in priority order

1. **Play through more of the game**: levels 3 to 8, the in-level math crates, level completion, credits. Expect
   the occasional "untranslated address" (a code pointer the scan missed) or "unimplemented API"; see item 4.
2. **Confirm real .bik files decode** (see 5a) and check how long a full-size cutscene takes on a normal machine.
   If transcoding is too slow, options are: lower `-b:v`, `-cpu-used 16`, or decode straight to frames and feed
   `BinkCopyToBuffer` instead of using an overlay.
3. **Music quality**: tinysynth is oscillator-based. A sampled instrument set would sound right, but published
   pages cannot fetch data files, only scripts from a short list of CDNs.
4. If a user reports "jump to untranslated address 0x...": add the address to an extra-leaders file (third argument
   of `lift.py`), rebuild. "unimplemented API X": add a `def()` in `host.js` with the right argument count.
5. Unchecked by ear: 3D sound positioning and overall loudness balance between effects and music.
6. Options screen changes (resolution, key bindings) are untested. The Level 1 camera sometimes shows the jeep far
   to one side in slow headless runs; unknown whether that is normal for the game.
7. Levels 3+ and the math mode have not been exercised by me at all.
8. Viewer only: LEV camera records, face flags and actor path keys are not decoded; `.PFF` is not decoded.
