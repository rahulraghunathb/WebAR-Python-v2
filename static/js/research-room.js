class ResearchRoomApp {
  constructor() {
    this.refreshTimer = 0
    this.connectionList = document.getElementById('connectionList')
    this.serverStatus = document.getElementById('serverStatus')
    this.latestRunGrid = document.getElementById('latestRunGrid')
    this.recentSessions = document.getElementById('recentSessions')
    this.programMeta = document.getElementById('programMeta')
    this.programText = document.getElementById('programText')
    this.refreshBtn = document.getElementById('refreshBtn')
    this.autoRefresh = document.getElementById('autoRefresh')
    this.saveExperimentBtn = document.getElementById('saveExperimentBtn')
    this.saveStatus = document.getElementById('saveStatus')
    this.form = document.getElementById('experimentForm')
  }

  async init() {
    this.bindEvents()
    await this.refresh()
    this.configureAutoRefresh()
  }

  bindEvents() {
    this.refreshBtn.addEventListener('click', () => this.refresh())
    this.autoRefresh.addEventListener('change', () => this.configureAutoRefresh())
    this.saveExperimentBtn.addEventListener('click', () => this.saveExperiment())
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-copy]')
      if (!button) {
        return
      }
      this.copyText(button.dataset.copy)
    })
  }

  configureAutoRefresh() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer)
      this.refreshTimer = 0
    }
    if (!this.autoRefresh.checked) {
      return
    }
    this.refreshTimer = window.setInterval(() => this.refresh(), 4000)
  }

  async fetchJson(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...(options || {}) })
    if (!response.ok) {
      throw new Error('Request failed with ' + response.status)
    }
    return response.json()
  }

  async refresh() {
    try {
      const payload = await this.fetchJson('/api/research-room')
      this.renderConnection(payload.connection || {})
      this.renderProgram(payload)
      this.renderExperiment(payload.experiment || {})
      this.renderLatestRun(payload.latest_session || null)
      this.renderRecentSessions(payload.recent_sessions || [])
    } catch (error) {
      console.error('[ResearchRoom] refresh failed', error)
      this.serverStatus.className = 'status-pill bad'
      this.serverStatus.textContent = 'Error'
      this.connectionList.innerHTML = '<div class="empty">Failed to load research-room payload.</div>'
    }
  }

  renderConnection(connection) {
    const urls = Array.isArray(connection.sameNetwork) ? connection.sameNetwork : []
    const hasUrls = urls.length > 0
    this.serverStatus.className = 'status-pill ' + (hasUrls ? 'good' : 'warn')
    this.serverStatus.textContent = hasUrls ? 'Ready' : 'Check Host'

    if (!hasUrls) {
      this.connectionList.innerHTML =
        '<div class="empty">No same-network URLs were detected. Start Flask on a LAN-reachable host and reload.</div>'
      return
    }

    this.connectionList.innerHTML = urls
      .map((entry) => (
        '<article class="url-card">' +
          '<div class="url-top">' +
            '<div class="url-label">' + this.escapeHtml(entry.host || 'host') + '</div>' +
            '<button class="copy-btn" type="button" data-copy="' + this.escapeHtml(entry.runtimeUrl || '') + '">Copy Runtime URL</button>' +
          '</div>' +
          '<div class="url-value">' + this.escapeHtml(entry.runtimeUrl || '') + '</div>' +
          '<div class="panel-sub">Room: ' + this.escapeHtml(entry.roomUrl || '') + '</div>' +
          '<div class="panel-sub">Dashboard: ' + this.escapeHtml(entry.dashboardUrl || '') + '</div>' +
        '</article>'
      ))
      .join('')
  }

  renderProgram(payload) {
    const path = payload.program_path || 'lab/program.md'
    const version = payload.program_version || '-'
    this.programMeta.textContent = 'Edit ' + path + ' on disk. Program version ' + version + '.'
    this.programText.textContent = payload.program || 'No research program loaded.'
  }

  renderExperiment(experiment) {
    const fields = [
      'experimentId',
      'hypothesis',
      'targetId',
      'presetId',
      'deviceLabel',
      'runTag',
      'operatorNote',
      'successCriteria',
    ]
    fields.forEach((field) => {
      const element = document.getElementById(field)
      if (element) {
        element.value = experiment[field] || ''
      }
    })
  }

  renderLatestRun(session) {
    if (!session) {
      this.latestRunGrid.innerHTML = '<div class="empty">No runs yet. Open the runtime on the phone and start one session.</div>'
      return
    }

    const cards = [
      ['Status', session.lastTargetState || '-', this.statusClass(session.lastTargetState || session.lastWorldState)],
      ['Target', session.lastTargetName || session.targetId || '-', ''],
      ['Device', session.deviceLabel || '-', ''],
      ['Hypothesis', session.hypothesis || '-', ''],
      ['Peak Inliers', String(session.peakTargetInliers || 0), ''],
      ['Peak Confidence', this.formatPercent(session.peakTargetConfidence || 0), ''],
      ['Avg FPS', this.formatNumber(session.avgFps || 0, 1), ''],
      ['Avg Capture Ms', this.formatNumber(session.avgCaptureMs || 0, 2), ''],
      ['Peak Visual Quality', this.formatPercent(session.peakVisualQuality || 0), ''],
    ]

    this.latestRunGrid.innerHTML = cards
      .map(([label, value, state]) => (
        '<article class="meta-card">' +
          '<div class="meta-label">' + this.escapeHtml(label) + '</div>' +
          (state
            ? '<div class="status-pill ' + state + '" style="margin-top:8px;display:inline-flex;">' + this.escapeHtml(String(value)) + '</div>'
            : '<div class="meta-value">' + this.escapeHtml(String(value)) + '</div>') +
        '</article>'
      ))
      .join('')
  }

  renderRecentSessions(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      this.recentSessions.innerHTML = '<div class="empty">No recent sessions stored.</div>'
      return
    }

    this.recentSessions.innerHTML = sessions
      .map((session) => (
        '<article class="session-card">' +
          '<div class="session-top">' +
            '<div class="session-label">' + this.escapeHtml(session.experimentId || session.sessionId) + '</div>' +
            '<div class="status-pill ' + this.statusClass(session.lastTargetState || session.lastWorldState) + '">' +
              this.escapeHtml(session.lastTargetState || session.lastWorldState || '-') +
            '</div>' +
          '</div>' +
          '<div class="session-value">' + this.escapeHtml(session.deviceLabel || '-') + ' | ' + this.escapeHtml(session.runTag || '-') + '</div>' +
          '<div class="session-meta">' +
            '<span class="panel-sub">' + this.escapeHtml(this.formatDateTime(session.lastSeenAtIso)) + '</span>' +
            '<span class="panel-sub">' + this.escapeHtml((session.peakTargetInliers || 0) + ' inliers | ' + this.formatNumber(session.avgFps || 0, 1) + ' fps') + '</span>' +
          '</div>' +
        '</article>'
      ))
      .join('')
  }

  async saveExperiment() {
    const payload = {
      experimentId: document.getElementById('experimentId').value.trim(),
      hypothesis: document.getElementById('hypothesis').value.trim(),
      targetId: document.getElementById('targetId').value.trim(),
      presetId: document.getElementById('presetId').value.trim(),
      deviceLabel: document.getElementById('deviceLabel').value.trim(),
      runTag: document.getElementById('runTag').value.trim(),
      operatorNote: document.getElementById('operatorNote').value.trim(),
      successCriteria: document.getElementById('successCriteria').value.trim(),
    }

    try {
      this.saveStatus.textContent = 'Saving active preset...'
      await this.fetchJson('/api/experiments/current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      this.saveStatus.textContent = 'Preset saved. Reload the phone runtime before the next run so telemetry uses the new metadata.'
      await this.refresh()
    } catch (error) {
      console.error('[ResearchRoom] save failed', error)
      this.saveStatus.textContent = 'Failed to save preset.'
    }
  }

  async copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ''))
    } catch (error) {
      console.error('[ResearchRoom] copy failed', error)
    }
  }

  statusClass(value) {
    const state = String(value || '').toUpperCase()
    if (['TRACKING', 'ACTIVE', 'MAPPED'].includes(state)) {
      return 'good'
    }
    if (['DETECTED', 'SCANNING', 'SEARCHING', 'RELOCALIZING', 'REACQUIRING', 'STARTING'].includes(state)) {
      return 'warn'
    }
    if (['ERROR', 'LOST', 'UNAVAILABLE'].includes(state)) {
      return 'bad'
    }
    return 'idle'
  }

  formatPercent(value) {
    return Math.round(Number(value || 0) * 100) + '%'
  }

  formatNumber(value, digits) {
    return Number(value || 0).toFixed(digits)
  }

  formatDateTime(value) {
    if (!value) {
      return '-'
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    return date.toLocaleString()
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new ResearchRoomApp()
  app.init()
})
