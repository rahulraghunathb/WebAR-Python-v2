const STATE_COLORS = {
  ACTIVE: '#00d98a',
  READY: '#79e07d',
  SUPPORTED: '#59e1a5',
  TRACKING: '#00d98a',
  MAPPED: '#2ce5b1',
  RELOCALIZING: '#f5c451',
  BOOTSTRAP: '#3aa2ff',
  SEARCHING: '#5e96ff',
  DETECTED: '#ffd56b',
  LOST: '#ff8f72',
  SCANNING: '#3aa2ff',
  STARTING: '#f5c451',
  LOADING: '#90b7ff',
  IDLE: '#6b7884',
  ENDED: '#5b636b',
  ERROR: '#ff6f6f',
  UNAVAILABLE: '#ff8f72',
  IMAGE_TARGET: '#75d7ff',
  IN_FLIGHT: '#3aa2ff',
  BACKPRESSURE: '#f5c451',
  THROTTLED: '#ff8f72',
}

class ReconstructionDashboard {
  constructor() {
    this.sessions = []
    this.selectedSessionId = null
    this.refreshTimer = 0

    this.sessionList = document.getElementById('sessionList')
    this.listCount = document.getElementById('listCount')
    this.sessionListMeta = document.getElementById('sessionListMeta')
    this.refreshBtn = document.getElementById('refreshBtn')
    this.autoRefresh = document.getElementById('autoRefresh')
    this.emptyState = document.getElementById('emptyState')
    this.detailView = document.getElementById('detailView')
    this.heroTitle = document.getElementById('heroTitle')
    this.heroMeta = document.getElementById('heroMeta')
    this.heroStatus = document.getElementById('heroStatus')
    this.heroFootnote = document.getElementById('heroFootnote')
    this.summaryGrid = document.getElementById('summaryGrid')
    this.stateTimeline = document.getElementById('stateTimeline')
    this.truncationNote = document.getElementById('truncationNote')
    this.mapGrowthChart = document.getElementById('mapGrowthChart')
    this.mapGrowthLegend = document.getElementById('mapGrowthLegend')
    this.trackingChart = document.getElementById('trackingChart')
    this.trackingLegend = document.getElementById('trackingLegend')
    this.trackingQualityChart = document.getElementById('trackingQualityChart')
    this.trackingQualityLegend = document.getElementById('trackingQualityLegend')
    this.mapHealthChart = document.getElementById('mapHealthChart')
    this.mapHealthLegend = document.getElementById('mapHealthLegend')
    this.relocalizationChart = document.getElementById('relocalizationChart')
    this.relocalizationLegend = document.getElementById('relocalizationLegend')
    this.baselineDeltaChart = document.getElementById('baselineDeltaChart')
    this.baselineDeltaLegend = document.getElementById('baselineDeltaLegend')
    this.performanceChart = document.getElementById('performanceChart')
    this.performanceLegend = document.getElementById('performanceLegend')
    this.eventTableBody = document.getElementById('eventTableBody')
  }


  async init() {
    this.bindEvents()
    await this.refresh(true)
    this.configureAutoRefresh()
  }


  bindEvents() {
    this.refreshBtn.addEventListener('click', () => this.refresh(true))
    this.autoRefresh.addEventListener('change', () => this.configureAutoRefresh())
    window.addEventListener('focus', () => {
      if (this.autoRefresh.checked) {
        this.refresh(true)
      }
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
    this.refreshTimer = window.setInterval(() => this.refresh(true), 5000)
  }


  async fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error('Request failed with ' + response.status)
    }
    return response.json()
  }


  async refresh(preserveSelection) {
    try {
      this.sessionListMeta.textContent = 'Loading session history...'
      const payload = await this.fetchJson('/api/reconstruction-sessions')
      this.sessions = Array.isArray(payload.sessions) ? payload.sessions : []
      this.renderSessionList()

      if (!this.sessions.length) {
        this.selectedSessionId = null
        this.showEmpty('No sessions recorded yet. Start a tracking run and this page will populate automatically.')
        this.sessionListMeta.textContent = 'Waiting for frontend telemetry from the tracker app'
        return
      }

      const hasSelectedSession =
        preserveSelection &&
        this.selectedSessionId &&
        this.sessions.some((session) => this.sessionDetailId(session) === this.selectedSessionId)
      const nextSessionId = hasSelectedSession
        ? this.selectedSessionId
        : this.sessionDetailId(this.sessions[0])
      await this.loadSession(nextSessionId)
      this.sessionListMeta.textContent =
        this.sessions.length +
        ' recent sessions | updated ' +
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch (error) {
      this.showEmpty('Failed to load reconstruction sessions. ' + error.message)
      this.sessionListMeta.textContent = error.message
      console.error('[Dashboard] refresh failed', error)
    }
  }


  async loadSession(sessionId) {
    this.selectedSessionId = sessionId
    this.renderSessionList()

    try {
      const payload = await this.fetchJson('/api/reconstruction-sessions/' + encodeURIComponent(sessionId))
      if (sessionId !== this.selectedSessionId) {
        return
      }
      this.renderDetail(payload.session, Array.isArray(payload.events) ? payload.events : [])
    } catch (error) {
      console.error('[Dashboard] session load failed', error)
      this.showEmpty('Could not load the selected session. It may have rolled out of the in-memory history.')
    }
  }

  sessionDetailId(session) {
    return session.detailId || session.runId || session.sessionId
  }


  renderSessionList() {
    this.listCount.textContent = String(this.sessions.length)
    this.sessionList.innerHTML = ''

    if (!this.sessions.length) {
      const empty = document.createElement('div')
      empty.className = 'muted'
      empty.textContent = 'No sessions yet.'
      this.sessionList.appendChild(empty)
      return
    }

    this.sessions.forEach((session) => {
      const detailId = this.sessionDetailId(session)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session-card' + (detailId === this.selectedSessionId ? ' active' : '')
      button.innerHTML =
        '<div class="session-card-top">' +
          '<div class="session-id" title="' + this.escapeHtml(session.sessionId) + '">' + this.escapeHtml(this.shortenSessionId(session.sessionId)) + '</div>' +
          '<div class="status-pill ' + this.statusClass(session) + '">' + this.escapeHtml(this.statusLabel(session)) + '</div>' +
        '</div>' +
        '<p>' + this.escapeHtml(this.formatDateTime(session.startedAtIso)) + '</p>' +
        '<div class="session-card-meta">' +
          '<span>' + this.escapeHtml(session.lastWorldState + ' / ' + session.lastTargetState) + '</span>' +
          '<span>' + this.escapeHtml(session.lastMapState) + '</span>' +
        '</div>' +
        '<div class="mini-line">' +
          '<span>' + this.escapeHtml(session.peakKeyframes + ' kf | ' + session.peakLandmarks + ' lm') + '</span>' +
          '<span>' + this.escapeHtml(this.formatNumber(session.maxFps, 1) + ' fps') + '</span>' +
        '</div>'
      button.addEventListener('click', () => this.loadSession(detailId))
      this.sessionList.appendChild(button)
    })
  }


  showEmpty(message) {
    this.emptyState.classList.remove('hidden')
    this.detailView.classList.add('hidden')
    this.emptyState.innerHTML =
      '<div><h2>No Session Data</h2><p>' + this.escapeHtml(message) + '</p></div>'
  }

}

document.addEventListener('DOMContentLoaded', () => {
  const dashboard = new ReconstructionDashboard()
  dashboard.init().catch((error) => {
    console.error('[Dashboard] init failed', error)
  })
})
