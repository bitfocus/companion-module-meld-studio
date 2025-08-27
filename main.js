import { InstanceBase, runEntrypoint } from '@companion-module/base'
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

function getModuleDir() {
  try {
    const p = process.argv?.[1]
    if (p) return path.dirname(p)
  } catch {}
  return process.cwd()
}

/** Load qwebchannel from packaged paths and execute in a sandbox */
function loadQWebChannelOrThrow(baseDir) {
  const candidates = [
    // 1) Preferred: packaged inside the module bundle under companion/
    path.join(baseDir, 'companion', 'vendor', 'qwebchannel.cjs'),
    path.join(baseDir, 'companion', 'vendor', 'qwebchannel.js'),
    // 2) Dev installs: vendor/ at root
    path.join(baseDir, 'vendor', 'qwebchannel.cjs'),
    path.join(baseDir, 'vendor', 'qwebchannel.js'),
    // 3) Last resort: next to main.js
    path.join(baseDir, 'qwebchannel.cjs'),
    path.join(baseDir, 'qwebchannel.js'),
  ]

  let picked = null
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      picked = p
      break
    }
  }
  if (!picked) {
    throw new Error(`qwebchannel not found (looked for: ${candidates.join(' , ')})`)
  }

  const code = fs.readFileSync(picked, 'utf8')
  const sandbox = { module: { exports: {} }, exports: {}, console, setTimeout, clearTimeout }
  vm.createContext(sandbox)
  new vm.Script(code, { filename: picked }).runInContext(sandbox)

  const exported = sandbox.module?.exports || sandbox.exports
  const QWebChannel = exported?.QWebChannel || exported?.default
  if (typeof QWebChannel !== 'function') throw new Error('QWebChannel export not found')
  return QWebChannel
}

class MeldStudioInstance extends InstanceBase {
  constructor(internal) {
    super(internal)
    this.ws = null
    this.QWebChannel = null
    this.qweb = null

    this.scenes = {}
    this.currentSceneId = null
    this.config = { host: '127.0.0.1', port: 13376 }
    this.baseDir = getModuleDir()
  }

  // Required in Companion v4
  getConfigFields() {
    return [
      { type: 'textinput', id: 'host', label: 'Host/IP', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Port', width: 6, min: 1, max: 65535, default: 13376 },
    ]
  }

  async init(config) {
    this.config = { host: config?.host || '127.0.0.1', port: Number(config?.port) || 13376 }
    this.updateStatus('connecting')

    this._defineFeedbacks()
    this._defineActions()
    this._definePresets() // initially empty; filled once scenes load

    this._connect()
  }

  async configUpdated(config) {
    this.config = { host: config?.host || '127.0.0.1', port: Number(config?.port) || 13376 }
    this.log('debug', `Config updated: ${this.config.host}:${this.config.port}`)
    this._connect()
  }

  async destroy() {
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  }

  _connect() {
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    try {
      const url = `ws://${this.config.host}:${this.config.port}`
      this.log('info', `Connecting to Meld Studio: ${url}`)
      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        try {
          this.QWebChannel = loadQWebChannelOrThrow(this.baseDir)
        } catch (err) {
          this.updateStatus('connection_failure', 'Failed to load qwebchannel.js')
          this.log('error', `Load qwebchannel.js failed: ${err.message}`)
          return
        }

        new this.QWebChannel(this.ws, (channel) => {
          this.qweb = channel.objects.meld
          this.updateStatus('ok')

          if (this.qweb?.sceneChanged?.connect) {
            this.qweb.sceneChanged.connect((id) => {
              this.currentSceneId = id
              this.checkFeedbacks('scene_active')
            })
          }

          this._refreshScenes()
        })
      })

      this.ws.on('close', () => {
        this.updateStatus('disconnected')
        setTimeout(() => this._connect(), 3000)
      })

      this.ws.on('error', (err) => {
        this.updateStatus('connection_failure', err?.message || 'WebSocket error')
      })
    } catch (e) {
      this.updateStatus('connection_failure', e?.message || 'Connect failed')
    }
  }

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
    this._definePresets() // regenerate presets now that we know scenes
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

    // Streaming toggle
    actions['toggle_stream'] = {
      name: 'Toggle Streaming',
      options: [],
      callback: async () => {
        if (!this.qweb) return
        if (typeof this.qweb.toggleStream === 'function') this.qweb.toggleStream()
        else if (typeof this.qweb.toggleStreaming === 'function') this.qweb.toggleStreaming()
      },
    }

    // Recording toggle
    actions['toggle_record'] = {
      name: 'Toggle Recording',
      options: [],
      callback: async () => {
        if (!this.qweb) return
        if (typeof this.qweb.toggleRecord === 'function') this.qweb.toggleRecord()
        else if (typeof this.qweb.toggleRecording === 'function') this.qweb.toggleRecording()
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
        options: [
          { type: 'dropdown', id: 'scene', label: 'Scene', choices: [] },
        ],
        defaultStyle: { bgcolor: 0xcc0000, color: 0xffffff }, // red when active
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
        options: [
          { type: 'dropdown', id: 'scene', label: 'Scene', choices: sceneChoices },
        ],
        defaultStyle: { bgcolor: 0xcc0000, color: 0xffffff },
        callback: (fb) => this.currentSceneId && fb.options?.scene === this.currentSceneId,
      },
    })
  }

  /** Build drag-and-drop presets for the Presets tab */
  _definePresets() {
    const presets = []

    // Category buckets (helps users find things)
    const catScenes = 'Scenes'
    const catControl = 'Control'

    // One preset per scene
    for (const id in this.scenes) {
      const scene = this.scenes[id]
      presets.push({
        type: 'button',
        category: catScenes,
        name: `Scene: ${scene.name}`,
        style: {
          text: scene.name,
          size: 'auto',
          color: 0xffffff,
          bgcolor: 0x000000,
        },
        steps: [
          {
            down: [
              { actionId: `show_scene_${id}`, options: {} },
            ],
            up: [],
          },
        ],
        feedbacks: [
          { feedbackId: 'scene_active', options: { scene: id } },
        ],
      })
    }

    // Streaming/Recording toggle presets (handy defaults)
    presets.push({
      type: 'button',
      category: catControl,
      name: 'Toggle Streaming',
      style: { text: 'Stream', size: 'auto', color: 0xffffff, bgcolor: 0x000000 },
      steps: [{ down: [{ actionId: 'toggle_stream', options: {} }], up: [] }],
      feedbacks: [],
    })

    presets.push({
      type: 'button',
      category: catControl,
      name: 'Toggle Recording',
      style: { text: 'Record', size: 'auto', color: 0xffffff, bgcolor: 0x000000 },
      steps: [{ down: [{ actionId: 'toggle_record', options: {} }], up: [] }],
      feedbacks: [],
    })

    this.setPresetDefinitions(presets)
  }
}

runEntrypoint(MeldStudioInstance, [])
