# Companion Module: Meld Studio

This is a [Bitfocus Companion](https://bitfocus.io/companion) module to control [Meld Studio](https://meldstudio.com) using its **Qt WebChannel** API.


### 1.0.0 Initial Release highlights
- Works on Companion v4 with CommonJS.
- No more local vendor path issues — uses `qwebchannel` npm package.
- Timecode variables for recording/streaming and ready-made presets.



## Features

- Connects to **Meld Studio** over WebSocket (Qt WebChannel).
- **Scene switching**: assign any scene to a button for instant switching.
- **Scene feedback**: button background changes to red when the scene is active.
- **Presets**: auto-generates drag-and-drop buttons for each discovered scene.
- **Recording control**: start, stop, and toggle recording directly from Companion.
- **Streaming control**: start, stop, and toggle streaming directly from Companion.
- Simple configuration (host/port).


## Requirements

- Companion v4.0 or later.
- Meld Studio running with WebChannel enabled.
- Default WebChannel port: **13376** (can be customized in module config).

## Configuration

1. Add the module in Companion (`Meld Studio`).
2. Set the **Host** (IP or `127.0.0.1` if local).
3. Set the **Port** (default `13376`).
4. Save & test the connection.

## Usage

- After configuring, your available scenes will appear in the **Actions** dropdown.
- Drag presets from the **Presets tab** to your Companion surface.
- Active scenes will highlight in **red** by default.

## Known Limitations

- Does not receive timecode feedback from Meld Studio as it currently is not supported

## Installation (Development)

```bash
git clone https://github.com/calmasacow/companion-module-meld-studio.git
cd companion-module-meld-studio
yarn install
yarn build
