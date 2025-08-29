const { InstanceBase, runEntrypoint } = require('@companion-module/base')
const WebSocket = require('ws')
const { QWebChannel } = require('qwebchannel')

// ---- Utilities ----
function formatHMS(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * Bridge a Node 'ws' socket to something QWebChannel expects (browser-like):
 *  - must have a `send(string)` function
 *  - must allow `onmessage = (event)` assignment; we trigger it when ws gets 'message'
 */
function makeWebChannelTransport(ws, log) {
  const transport = {
    onmessage: null,
    send: (data) => {
      try {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data))
      } catch (e) {
        log?.('error', `Transport send failed: ${e?.message || e}`)
      }
    },
  }

  ws.on('message', (data) => {
    try {
      const text = typeof data === 'string' ? data : data.toString()
      if (typeof transport.onmessage === 'function') {
        transport.onmessage({ data: text })
      }
    } catch (e) {
      log?.('error', `Transport onmessage failed: ${e?.message || e}`)
    }
  })

  return transport
}

class MeldStudioInstance extends InstanceBase {
  constructor(internal) {
    super(internal)

    // connection
    this.ws = null
    this.qweb = null
    this.config = { host: '127.0.0.1', port: 13376 }

    // scenes
    this.scenes = {}
    this.currentSceneId = null

    // internal timers
    this.isRecording = false
    this.isStreaming = false
    this.recordStart = null
    this.streamStart = null
    this.recordTimer = null
    this.streamTimer = null
  }

  getConfigFields() {
    return [
      { type: 'textinput', id: 'host', label: 'Host/IP', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Port', width: 6, min: 1, max: 65535, default: 13376 },
    ]
  }

  async init(config) {
    this.config = { host: config?.host || '127.0.0.1', port: Number(config?.port) || 13376 }
    this.updateStatus('connecting')

    this.setVariableDefinitions([
      { variableId: 'recording_timecode', name: 'Recording Timecode' },
      { variableId: 'streaming_timecode', name: 'Streaming Timecode' },
    ])
    this.setVariableValues({ recording_timecode: '00:00:00', streaming_timecode: '00:00:00' })

    this._defineFeedbacks()
    this._defineActions()
    this._definePresets()

    this._connect()
  }

  async configUpdated(config) {
    this.config = { host: config?.host || '127.0.0.1', port: Number(config?.port) || 13376 }
    this.log('debug', `Config updated: ${this.config.host}:${this.config.port}`)
    this._connect()
  }

  async destroy() {
    this._stopRecordTimer()
    this._stopStreamTimer()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
  }

  // ---------------- Connection / WebChannel ----------------

  _connect() {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }

    try {
      const url = `ws://${this.config.host}:${this.config.port}`
      this.log('info', `Connecting to Meld Studio: ${url}`)
      const ws = new WebSocket(url)
      this.ws = ws

      ws.on('open', () => {
        const transport = makeWebChannelTransport(ws, (lvl, msg) => this.log(lvl, msg))
        try {
          new QWebChannel(transport, (channel) => {
            this.qweb = channel.objects.meld
            this.updateStatus('ok')

            if (this.qweb?.sceneChanged?.connect) {
              this.qweb.sceneChanged.connect((id) => {
                this.currentSceneId = id
                this.checkFeedbacks('scene_active')
              })
            }

            if (this.qweb?.isRecordingChanged?.connect) {
              this.qweb.isRecordingChanged.connect(() =>
                this._onRecordingStateChange(!!this.qweb.isRecording)
              )
            }
            if (this.qweb?.isStreamingChanged?.connect) {
              this.qweb.isStreamingChanged.connect(() =>
                this._onStreamingStateChange(!!this.qweb.isStreaming)
              )
            }

            if (typeof this.qweb?.isRecording === 'boolean') this._onRecordingStateChange(this.qweb.isRecording)
            if (typeof this.qweb?.isStreaming === 'boolean') this._onStreamingStateChange(this.qweb.isStreaming)

            this._refreshScenes()
          })
        } catch (e) {
          this.updateStatus('connection_failure', 'QWebChannel init failed')
          this.log('error', `QWebChannel init failed: ${e?.message || e}`)
          try { ws.close() } catch {}
        }
      })

      ws.on('close', () => {
        this.updateStatus('disconnected')
        this._stopRecordTimer()
        this._stopStreamTimer()
        setTimeout(() => this._connect(), 3000)
      })

      ws.on('error', (err) => {
        this.updateStatus('connection_failure', err?.message || 'WebSocket error')
      })
    } catch (e) {
      this.updateStatus('connection_failure', e?.message || 'Connect failed')
    }
  }

  // --------------- Internal timers ---------------

  _onRecordingStateChange(active) {
    if (active && !this.isRecording) this._startRecording()
    else if (!active && this.isRecording) this._stopRecording()
  }

  _onStreamingStateChange(active) {
    if (active && !this.isStreaming) this._startStreaming()
    else if (!active && this.isStreaming) this._stopStreaming()
  }

  _startRecording() {
    this.isRecording = true
    this.recordStart = Date.now()
    this._stopRecordTimer()
    this.recordTimer = setInterval(() => {
      const tc = formatHMS(Date.now() - (this.recordStart || Date.now()))
      this.setVariableValues({ recording_timecode: tc })
    }, 1000)
  }

  _stopRecording() {
    this.isRecording = false
    this._stopRecordTimer()
    this.setVariableValues({ recording_timecode: '00:00:00' })
  }

  _startStreaming() {
    this.isStreaming = true
    this.streamStart = Date.now()
    this._stopStreamTimer()
    this.streamTimer = setInterval(() => {
      const tc = formatHMS(Date.now() - (this.streamStart || Date.now()))
      this.setVariableValues({ streaming_timecode: tc })
    }, 1000)
  }

  _stopStreaming() {
    this.isStreaming = false
    this._stopStreamTimer()
    this.setVariableValues({ streaming_timecode: '00:00:00' })
  }

  _stopRecordTimer() {
    if (this.recordTimer) {
      clearInterval(this.recordTimer)
      this.recordTimer = null
    }
  }

  _stopStreamTimer() {
    if (this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }
  }

  // ---------------- Scenes / Actions / Feedbacks / Presets ----------------

  _refreshScenes() {
    if (!this.qweb) return

    if (typeof this.qweb.getScenes === 'function') {
      this.qweb.getScenes((scenes) => this._ingestScenes(scenes))
    } else if (this.qweb.session && this.qweb.session.items) {
      const items = this.qweb.session.items
      const scenes = Object.keys(items)
        .filter((id) => items[id]?.type === 'scene')
        .map((id) => ({ id, name: items[id]?.name || id }))
      this._ingestScenes(scenes)
    } else {
      this.log('warn', 'Unable to discover scenes (no getScenes() or session.items).')
    }
  }

  _ingestScenes(scenesArray) {
    this.scenes = {}
    for (const scene of scenesArray || []) {
      const cleanName = String(scene.name || scene.id).replace(/\s*\(.*?\)\s*$/, '')
      this.scenes[scene.id] = { id: scene.id, name: cleanName }
    }

    this._defineActions()
    this._refreshFeedbackChoices()
    this._definePresets()
  }

  _defineActions() {
    const actions = {}

    // One action per scene
    for (const id in this.scenes) {
      const scene = this.scenes[id]
      actions[`show_scene_${id}`] = {
        name: `Show Scene: ${scene.name}`,
        options: [],
        callback: async () => {
          if (!this.qweb) return
          if (typeof this.qweb.showScene === 'function') this.qweb.showScene(id)
          else if (typeof this.qweb.switchScene === 'function') this.qweb.switchScene(id)
        },
      }
    }

    // Streaming controls
    actions['toggle_stream'] = {
      name: 'Toggle Streaming',
      options: [],
      callback: async () => {
        if (this.qweb) {
          if (typeof this.qweb.toggleStream === 'function') this.qweb.toggleStream()
          else if (typeof this.qweb.toggleStreaming === 'function') this.qweb.toggleStreaming()
        }
        if (this.isStreaming) this._stopStreaming()
        else this._startStreaming()
      },
    }
    actions['start_stream'] = {
      name: 'Start Streaming',
      options: [],
      callback: async () => {
        if (this.qweb && typeof this.qweb.startStream === 'function') this.qweb.startStream()
        if (!this.isStreaming) this._startStreaming()
      },
    }
    actions['stop_stream'] = {
      name: 'Stop Streaming',
      options: [],
      callback: async () => {
        if (this.qweb && typeof this.qweb.stopStream === 'function') this.qweb.stopStream()
        if (this.isStreaming) this._stopStreaming()
      },
    }

    // Recording controls
    actions['toggle_record'] = {
      name: 'Toggle Recording',
      options: [],
      callback: async () => {
        if (this.qweb) {
          if (typeof this.qweb.toggleRecord === 'function') this.qweb.toggleRecord()
          else if (typeof this.qweb.toggleRecording === 'function') this.qweb.toggleRecording()
        }
        if (this.isRecording) this._stopRecording()
        else this._startRecording()
      },
    }
    actions['start_record'] = {
      name: 'Start Recording',
      options: [],
      callback: async () => {
        if (this.qweb && typeof this.qweb.startRecord === 'function') this.qweb.startRecord()
        if (!this.isRecording) this._startRecording()
      },
    }
    actions['stop_record'] = {
      name: 'Stop Recording',
      options: [],
      callback: async () => {
        if (this.qweb && typeof this.qweb.stopRecord === 'function') this.qweb.stopRecord()
        if (this.isRecording) this._stopRecording()
      },
    }

    this.setActionDefinitions(actions)
  }

  _defineFeedbacks() {
    this.setFeedbackDefinitions({
      scene_active: {
        type: 'boolean',
        name: 'Scene Active',
        description: 'Change button style if the selected scene is currently live.',
        options: [{ type: 'dropdown', id: 'scene', label: 'Scene', choices: [] }],
        defaultStyle: { bgcolor: 0xcc0000, color: 0xffffff },
        callback: (fb) => this.currentSceneId && fb.options?.scene === this.currentSceneId,
      },
    })
  }

  _refreshFeedbackChoices() {
    const sceneChoices = Object.values(this.scenes).map((s) => ({ id: s.id, label: s.name }))
    this.setFeedbackDefinitions({
      scene_active: {
        type: 'boolean',
        name: 'Scene Active',
        description: 'Change button style if the selected scene is currently live.',
        options: [{ type: 'dropdown', id: 'scene', label: 'Scene', choices: sceneChoices }],
        defaultStyle: { bgcolor: 0xcc0000, color: 0xffffff },
        callback: (fb) => this.currentSceneId && fb.options?.scene === this.currentSceneId,
      },
    })
  }

  _definePresets() {
    const presets = []
    const catScenes = 'Scenes'
    const catControl = 'Control'

    for (const id in this.scenes) {
      const scene = this.scenes[id]
      presets.push({
        type: 'button',
        category: catScenes,
        name: `Scene: ${scene.name}`,
        style: { text: scene.name, size: 'auto', color: 0xffffff, bgcolor: 0x000000 },
        steps: [{ down: [{ actionId: `show_scene_${id}`, options: {} }], up: [] }],
        feedbacks: [{ feedbackId: 'scene_active', options: { scene: id } }],
      })
    }

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Toggle Streaming',
      style: {
        text: 'Stream\n$(meldstudio:streaming_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x000000,
      },
      steps: [{ down: [{ actionId: 'toggle_stream', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Toggle Recording',
      style: {
        text: 'Record\n$(meldstudio:recording_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x000000,
      },
      steps: [{ down: [{ actionId: 'toggle_record', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Start Streaming',
      style: {
        text: 'Start Stream\n$(meldstudio:streaming_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x003300,
      },
      steps: [{ down: [{ actionId: 'start_stream', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Stop Streaming',
      style: {
        text: 'Stop Stream\n$(meldstudio:streaming_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x330000,
      },
      steps: [{ down: [{ actionId: 'stop_stream', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Start Recording',
      style: {
        text: 'Start Rec\n$(meldstudio:recording_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x003300,
      },
      steps: [{ down: [{ actionId: 'start_record', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Stop Recording',
      style: {
        text: 'Stop Rec\n$(meldstudio:recording_timecode)',
        size: 'auto',
        color: 0xffffff,
        bgcolor: 0x330000,
      },
      steps: [{ down: [{ actionId: 'stop_record', options: {} }], up: [] }],
      feedbacks: [],
    })

    this.setPresetDefinitions(presets)
  }
}

runEntrypoint(MeldStudioInstance, [])
