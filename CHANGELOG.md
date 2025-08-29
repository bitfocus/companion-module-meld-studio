# Changelog

All notable changes to this project will be documented in this file.  
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),  
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).





---

## [Unreleased] - 2025-08-28
### Added
- Internal timecode timers for Recording and Streaming, exposed as variables:
  - `$(meldstudio:recording_timecode)`
  - `$(meldstudio:streaming_timecode)`
- Drag-and-drop presets:
  - One preset per Scene (with active-scene feedback)
  - Toggle/Start/Stop Streaming (shows timecode)
  - Toggle/Start/Stop Recording (shows timecode)

### Changed
- Switched module to **CommonJS** for better compatibility with Companion v4.
- Use npm `qwebchannel` package directly (no `fs`/`vm` loader).
- Added WebSocket→WebChannel **transport shim** to match QWebChannel’s browser-style transport.
- Simplified packaging; removed hardcoded vendor path.

### Fixed
- Packaging issue where `qwebchannel.js` path caused runtime failures on other machines.
- Build errors by disabling optional native `ws` addons.

### Developer notes
- `package.json`:
  - `"type": "commonjs"`
  - `"browser": { "bufferutil": false, "utf-8-validate": false }`

## [1.0.0] - 2025-08-15
### Added
- Initial public release of the **Meld Studio Companion Module**.
- Ability to connect to **Meld Studio** via Qt WebChannel (WebSocket).
- **Scene switching** action: allows Companion buttons to trigger a change of scene inside Meld Studio.
- **Feedback**: active scene button highlights with a red background (`#CC0000`) when the scene is live.
- **Presets**: automatic generation of drag-and-drop buttons for all scenes discovered in Meld Studio.
- Configurable connection settings (host, port).
- **Recording control**: start, stop, and toggle recording from Companion.
- **Streaming control**: start, stop, and toggle streaming from Companion.

### Notes
- This release focuses on **scene control, streaming, and recording**.  
- Future updates may include parameter control, timeline triggers, or multi-scene state awareness.
- Timecode feedback once implemented by Meld Studio.
