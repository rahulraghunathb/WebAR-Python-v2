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
        preserveSelection && this.selectedSessionId && this.sessions.some((session) => session.sessionId === this.selectedSessionId)
      const nextSessionId = hasSelectedSession ? this.selectedSessionId : this.sessions[0].sessionId
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
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session-card' + (session.sessionId === this.selectedSessionId ? ' active' : '')
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
      button.addEventListener('click', () => this.loadSession(session.sessionId))
      this.sessionList.appendChild(button)
    })
  }

  renderDetail(summary, events) {
    this.emptyState.classList.add('hidden')
    this.detailView.classList.remove('hidden')

    this.heroTitle.textContent = summary.sessionId
    this.heroMeta.innerHTML =
      '<span>Started ' + this.escapeHtml(this.formatDateTime(summary.startedAtIso)) + '</span>' +
      '<span>Last seen ' + this.escapeHtml(this.formatDateTime(summary.lastSeenAtIso)) + '</span>' +
      '<span>' + this.escapeHtml(this.formatDuration(summary.durationMs)) + '</span>'
    this.heroStatus.className = 'status-pill ' + this.statusClass(summary)
    this.heroStatus.textContent = this.statusLabel(summary)
    this.heroFootnote.textContent =
      'Build ' + (summary.buildSignature || '-') + ' | ' + (summary.trackingMode || '-')

    const summaryCards = [
      {
        label: 'Duration',
        tooltip: 'Why it matters: longer stable runs tell you whether tracking stays reliable over time. If stored events are fewer than total events, older rows were trimmed from memory.',
        value: this.formatDuration(summary.durationMs),
        meta: 'Stored window: ' + summary.storedEventCount + ' of ' + summary.eventCount + ' events',
      },
      {
        label: 'Final State',
        tooltip: 'Why it matters: this shows whether the run finished in stable tracking, recovery, or failure. The world, visual, and map states tell you which subsystem was weak at the end.',
        value: summary.lastTargetState,
        meta: 'World ' + summary.lastWorldState + ' | Visual ' + summary.lastVisualState + ' | Map ' + summary.lastMapState,
      },
      {
        label: 'Target Lock',
        tooltip: 'Why it matters: inliers are the strongest signal for whether the model can actually stay glued to the image target. Matches alone can be noisy; inliers show geometric agreement.',
        value: summary.peakTargetInliers + ' inliers',
        meta:
          summary.peakTargetMatches + ' peak matches | ' +
          this.formatPercent(summary.peakTargetInlierRatio) + ' inlier ratio | ' +
          this.formatPercent(summary.peakTargetConfidence) + ' confidence',
      },
      {
        label: 'Tracking Quality',
        tooltip: 'Why it matters: observability and track persistence tell you whether the estimator is learning from motion and keeping useful features alive instead of constantly resetting.',
        value: this.formatPercent(summary.avgMotionObservability) + ' observable',
        meta:
          this.formatNumber(summary.avgTrackAge, 1) + ' avg track age | ' +
          this.formatPercent(summary.avgLongTrackRatio) + ' long tracks | ' +
          this.formatPercent(summary.peakMotionObservability) + ' peak',
      },
      {
        label: 'Map Growth',
        tooltip: 'Why it matters: stable growth in keyframes and landmarks usually means the worker built a stronger local feature map instead of constantly rebuilding from scratch.',
        value: summary.peakKeyframes + ' kf',
        meta:
          summary.peakLandmarks + ' landmarks | ' +
          this.formatChartValue(summary.peakKeyframeGrowthPerSec, 'persec') + ' kf | ' +
          this.formatChartValue(summary.peakLandmarkGrowthPerSec, 'persec') + ' lm',
      },
      {
        label: 'Map Health',
        tooltip: 'Why it matters: a map can grow and still become unhealthy if stale state dominates. Lower stale-landmark ratios usually mean the map is staying usable.',
        value: this.formatPercent(Math.max(0, 1 - Number(summary.peakStaleLandmarkRatio || 0))) + ' healthy',
        meta:
          this.formatPercent(summary.peakStaleLandmarkRatio) + ' peak stale ratio | dominant ' + summary.dominantMapState,
      },
      {
        label: 'Relocalization',
        tooltip: 'Why it matters: frequent or long relocalization windows mean the tracker is recovering often instead of holding a stable pose throughout the run.',
        value: String(summary.peakRelocalizationAttempts) + ' attempts',
        meta:
          summary.peakRelocalizationRecoveries + ' recoveries | ' +
          this.formatDuration(summary.maxRelocalizationDurationMs) + ' max | ' +
          this.formatPercent(summary.peakRelocalizationScore) + ' peak score',
      },
      {
        label: 'Baseline Delta',
        tooltip: 'Why it matters: disagreement against the native measurement stream is one of the clearest early signals for drift or a filter that looks smooth but is wrong.',
        value: this.formatChartValue(summary.avgMeasurementDeltaTranslationM, 'meters'),
        meta:
          this.formatChartValue(summary.avgMeasurementDeltaRotationDeg, 'deg') + ' avg rotation delta | worker vs native',
      },
      {
        label: 'Performance',
        tooltip: 'Why it matters: if frame, capture, or visual-processing time spikes, tracking quality usually drops before the user notices obvious drift.',
        value: this.formatNumber(summary.avgFps, 1) + ' fps',
        meta:
          this.formatNumber(summary.avgFrameMs, 2) + ' ms frame | ' +
          this.formatNumber(summary.avgCaptureMs, 2) + ' ms capture | ' +
          this.formatNumber(summary.avgVisualProcMs, 2) + ' ms visual',
      },
      {
        label: 'Events',
        tooltip: 'Why it matters: this tells you whether the session was calm or thrashy. Lots of transitions usually mean the tracker kept bouncing between lock and recovery.',
        value: String(summary.eventCount),
        meta:
          summary.runtimeSnapshotCount + ' snapshots | ' +
          summary.transitionCount + ' transitions | ' +
          summary.errorCount + ' errors',
      },
    ]

    this.summaryGrid.innerHTML = summaryCards
      .map(
        (card) =>
          '<article class="stat-card">' +
            '<div class="stat-label">' + this.buildMetricLabel(card.label, card.tooltip) + '</div>' +
            '<div class="stat-value">' + this.escapeHtml(card.value) + '</div>' +
            '<div class="stat-meta">' + this.escapeHtml(card.meta) + '</div>' +
          '</article>'
      )
      .join('')

    this.renderStateTimeline(events)
    this.truncationNote.textContent = summary.truncated
      ? 'Only the latest ' + summary.storedEventCount + ' events are retained for this session on the server.'
      : 'Full session telemetry is currently retained for this run.'

    this.renderLineChart(this.mapGrowthChart, this.mapGrowthLegend, events, [
      { key: 'keyframeCount', label: 'Keyframes', color: '#00d98a' },
      { key: 'landmarkCount', label: 'Landmarks', color: '#3aa2ff' },
    ], { unit: 'count' })

    this.renderLineChart(this.trackingChart, this.trackingLegend, events, [
      { key: 'targetMatchCount', label: 'Matches', color: '#3aa2ff', unit: 'count' },
      { key: 'targetInlierCount', label: 'Inliers', color: '#f5c451', unit: 'count' },
      { key: 'trackCount', label: 'Tracks', color: '#00d98a', unit: 'count' },
    ], { unit: 'count' })

    this.renderLineChart(this.trackingQualityChart, this.trackingQualityLegend, events, [
      { key: 'targetInlierRatio', label: 'Inlier ratio', color: '#ffd56b', unit: 'percent', transform: (event) => Number(event.targetInlierRatio || 0) * 100 },
      { key: 'motionObservability', label: 'Observability', color: '#00d98a', unit: 'percent', transform: (event) => Number(event.motionObservability || 0) * 100 },
      { key: 'longTrackRatio', label: 'Long-track ratio', color: '#3aa2ff', unit: 'percent', transform: (event) => Number(event.longTrackRatio || 0) * 100 },
    ], { unit: 'percent', normalize: true })

    this.renderLineChart(this.mapHealthChart, this.mapHealthLegend, events, [
      { key: 'stableLandmarkCount', label: 'Stable landmarks', color: '#00d98a', unit: 'count' },
      { key: 'staleLandmarkCount', label: 'Stale landmarks', color: '#ff8f72', unit: 'count' },
      { key: 'keyframeGrowthPerSec', label: 'Keyframe growth', color: '#3aa2ff', unit: 'persec' },
      { key: 'landmarkGrowthPerSec', label: 'Landmark growth', color: '#75d7ff', unit: 'persec' },
    ], { unit: 'count', normalize: true })

    this.renderLineChart(this.relocalizationChart, this.relocalizationLegend, events, [
      { key: 'relocalizationScore', label: 'Reloc score', color: '#f5c451', unit: 'percent', transform: (event) => Number(event.relocalizationScore || 0) * 100 },
      { key: 'currentRelocalizationDurationMs', label: 'Active reloc ms', color: '#ff8f72', unit: 'ms' },
      { key: 'relocalizationAttemptCount', label: 'Attempts', color: '#3aa2ff', unit: 'count' },
      { key: 'relocalizationRecoveryCount', label: 'Recoveries', color: '#00d98a', unit: 'count' },
    ], { unit: 'count', normalize: true })

    this.renderLineChart(this.baselineDeltaChart, this.baselineDeltaLegend, events, [
      { key: 'measurementDeltaTranslationM', label: 'Translation delta', color: '#75d7ff', unit: 'meters' },
      { key: 'measurementDeltaRotationDeg', label: 'Rotation delta', color: '#ffd56b', unit: 'deg' },
      { key: 'targetReprojectionPx', label: 'Reprojection', color: '#ff8f72', unit: 'px' },
    ], { unit: 'count', normalize: true })

    this.renderLineChart(this.performanceChart, this.performanceLegend, events, [
      { key: 'frameTimeMs', label: 'Frame ms', color: '#ff8f72', unit: 'ms' },
      { key: 'cameraAverageCaptureMs', label: 'Capture ms', color: '#3aa2ff', unit: 'ms' },
      { key: 'visualProcMs', label: 'Visual proc ms', color: '#00d98a', unit: 'ms' },
    ], { unit: 'ms' })

    this.renderEventTable(events)
  }

  renderStateTimeline(events) {
    if (!events.length) {
      this.stateTimeline.innerHTML = '<div class="muted">No telemetry events captured for this session.</div>'
      return
    }

    const rows = [
      { label: 'World', field: 'worldState' },
      { label: 'Target', field: 'targetState' },
      { label: 'Visual', field: 'visualState' },
      { label: 'Map', field: 'mapState' },
    ]

    this.stateTimeline.innerHTML = rows
      .map((row) => {
        const segments = this.buildSegments(events, row.field)
        const bar = segments
          .map((segment) => {
            const state = String(segment.value || '-')
            return (
              '<div class="state-segment" ' +
              'style="flex:' + Math.max(segment.count, 1) + ';background:' + this.colorForState(state) + ';" ' +
              'title="' + this.escapeHtml(row.label + ': ' + state + ' (' + segment.count + ' samples)') + '"></div>'
            )
          })
          .join('')
        return (
          '<div class="state-row">' +
            '<div class="state-label">' + this.escapeHtml(row.label) + '</div>' +
            '<div class="state-track">' + bar + '</div>' +
          '</div>'
        )
      })
      .join('')
  }

  renderLineChart(container, legendEl, events, series, options = {}) {
    if (!container || !legendEl) {
      return
    }
    if (!events.length) {
      container.innerHTML = '<div class="empty-state" style="min-height:100%;"><div><p>No chart data yet.</p></div></div>'
      legendEl.innerHTML = ''
      return
    }

    const chartOptions = { unit: 'count', normalize: false, ...options }
    const width = 800
    const height = 230
    const margin = { top: 16, right: 18, bottom: 28, left: 42 }
    const plotWidth = width - margin.left - margin.right
    const plotHeight = height - margin.top - margin.bottom
    const prepared = series.map((entry) => {
      const values = events.map((event, index) => {
        if (typeof entry.transform === 'function') {
          return Number(entry.transform(event, index) || 0)
        }
        return Number(event[entry.key] || 0)
      })
      const peak = Math.max(0, ...values)
      const plotValues = chartOptions.normalize
        ? values.map((value) => (peak > 0 ? (value / peak) * 100 : 0))
        : values
      return { ...entry, values, plotValues, peak }
    })
    const maxValue = chartOptions.normalize ? 100 : Math.max(1, ...prepared.flatMap((entry) => entry.values))

    const grid = []
    for (let step = 0; step <= 4; step += 1) {
      const ratio = step / 4
      const y = margin.top + plotHeight - ratio * plotHeight
      const labelValue = chartOptions.normalize
        ? Math.round(maxValue * ratio) + '%'
        : this.formatChartValue(maxValue * ratio, chartOptions.unit)
      grid.push(
        '<line x1="' + margin.left + '" y1="' + y + '" x2="' + (margin.left + plotWidth) + '" y2="' + y + '" stroke="rgba(255,255,255,0.08)" stroke-width="1" />' +
        '<text x="8" y="' + (y + 4) + '" fill="rgba(255,255,255,0.5)" font-size="11">' + this.escapeHtml(labelValue) + '</text>'
      )
    }

    const polylines = prepared
      .map((entry) => {
        const points = entry.plotValues
          .map((value, index) => {
            const x =
              events.length === 1
                ? margin.left + plotWidth / 2
                : margin.left + (index / (events.length - 1)) * plotWidth
            const y = margin.top + plotHeight - (value / Math.max(maxValue, 1)) * plotHeight
            return x.toFixed(2) + ',' + y.toFixed(2)
          })
          .join(' ')
        return '<polyline fill="none" stroke="' + entry.color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="' + points + '" />'
      })
      .join('')

    const firstLabel = this.formatDuration(Number(events[0].elapsedMs || 0))
    const lastLabel = this.formatDuration(Number(events[events.length - 1].elapsedMs || 0))

    container.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-label="Session chart">' +
        grid.join('') +
        '<line x1="' + margin.left + '" y1="' + (margin.top + plotHeight) + '" x2="' + (margin.left + plotWidth) + '" y2="' + (margin.top + plotHeight) + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" />' +
        polylines +
        '<text x="' + margin.left + '" y="' + (height - 6) + '" fill="rgba(255,255,255,0.5)" font-size="11">' + this.escapeHtml(firstLabel) + '</text>' +
        '<text x="' + (margin.left + plotWidth - 48) + '" y="' + (height - 6) + '" fill="rgba(255,255,255,0.5)" font-size="11">' + this.escapeHtml(lastLabel) + '</text>' +
      '</svg>'

    legendEl.innerHTML = prepared
      .map((entry) => {
        return (
          '<div class="legend-item">' +
            '<span class="legend-swatch" style="background:' + entry.color + ';"></span>' +
            '<span>' + this.escapeHtml(entry.label + ' | peak ' + this.formatChartValue(entry.peak, entry.unit || chartOptions.unit)) + '</span>' +
          '</div>'
        )
      })
      .join('')
  }

  renderEventTable(events) {
    const rows = events.slice(-16).reverse()
    this.eventTableBody.innerHTML = rows
      .map((event) => {
        const lockSummary = this.formatPercent(event.targetInlierRatio || 0) + ' | ' + this.formatPercent(event.targetConfidence || 0)
        const mapHealthSummary = this.formatPercent(event.motionObservability || 0) + ' obs | ' + this.formatPercent(event.staleLandmarkRatio || 0) + ' stale'
        const deltaSummary = this.formatChartValue(event.measurementDeltaTranslationM || 0, 'meters') + ' | ' + this.formatChartValue(event.measurementDeltaRotationDeg || 0, 'deg')
        return (
          '<tr>' +
            '<td class="cell-strong">' + this.escapeHtml(this.formatDuration(event.elapsedMs)) + '</td>' +
            '<td>' + this.escapeHtml(event.kind || '-') + '</td>' +
            '<td>' + this.escapeHtml(event.source || '-') + '</td>' +
            '<td>' + this.escapeHtml(event.worldState || '-') + '</td>' +
            '<td>' + this.escapeHtml(event.targetState || '-') + '</td>' +
            '<td>' + this.escapeHtml(event.visualState || '-') + '</td>' +
            '<td>' + this.escapeHtml(event.mapState || '-') + '</td>' +
            '<td>' + this.escapeHtml((event.keyframeCount || 0) + '/' + (event.landmarkCount || 0)) + '</td>' +
            '<td>' + this.escapeHtml(lockSummary) + '</td>' +
            '<td>' + this.escapeHtml(mapHealthSummary) + '</td>' +
            '<td>' + this.escapeHtml(deltaSummary) + '</td>' +
            '<td>' + this.escapeHtml(this.formatNumber(event.xrFps || 0, 1)) + '</td>' +
          '</tr>'
        )
      })
      .join('')
  }

  buildSegments(events, field) {
    const segments = []
    events.forEach((event) => {
      const value = String(event[field] || '-')
      const last = segments[segments.length - 1]
      if (last && last.value === value) {
        last.count += 1
        return
      }
      segments.push({ value, count: 1 })
    })
    return segments
  }

  buildMetricLabel(label, tooltip) {
    return '<span class="metric-heading">' + this.escapeHtml(label) + (tooltip ? this.renderMetricHelp(label, tooltip) : '') + '</span>'
  }

  renderMetricHelp(label, text) {
    return '<span class="metric-help" tabindex="0" aria-label="' + this.escapeHtml(label + ' help') + '"><span class="metric-help-icon">?</span><span class="metric-help-bubble">' + this.escapeHtml(text) + '</span></span>'
  }

  showEmpty(message) {
    this.emptyState.classList.remove('hidden')
    this.detailView.classList.add('hidden')
    this.emptyState.innerHTML =
      '<div><h2>No Session Data</h2><p>' + this.escapeHtml(message) + '</p></div>'
  }

  statusClass(session) {
    if (session.active) {
      return 'active'
    }
    if (session.errorCount > 0 || session.lastKind === 'error') {
      return 'bad'
    }
    if (['TRACKING', 'DETECTED', 'MAPPED', 'RELOCALIZING'].includes(session.lastTargetState) || ['TRACKING', 'MAPPED', 'RELOCALIZING'].includes(session.lastMapState)) {
      return 'warn'
    }
    return 'idle'
  }

  statusLabel(session) {
    if (session.active) {
      return 'Live'
    }
    if (session.lastTargetState && session.lastTargetState !== '-') {
      return session.lastTargetState
    }
    return session.lastKind || 'Idle'
  }

  colorForState(value) {
    return STATE_COLORS[value] || '#7d8790'
  }

  shortenSessionId(value) {
    if (!value || value.length <= 26) {
      return value || '-'
    }
    return value.slice(0, 20) + '...' + value.slice(-4)
  }

  formatDateTime(isoValue) {
    if (!isoValue) {
      return '-'
    }
    const date = new Date(isoValue)
    if (Number.isNaN(date.getTime())) {
      return String(isoValue)
    }
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  formatDuration(value) {
    const ms = Number(value || 0)
    if (ms >= 60000) {
      return (ms / 60000).toFixed(1) + 'm'
    }
    if (ms >= 1000) {
      return (ms / 1000).toFixed(1) + 's'
    }
    return Math.round(ms) + 'ms'
  }

  formatPercent(value) {
    return Math.round(Number(value || 0) * 100) + '%'
  }

  formatNumber(value, digits) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? number.toFixed(digits) : Number(0).toFixed(digits)
  }

  formatChartValue(value, unit) {
    const rawNumber = Number(value || 0)
    const number = Number.isFinite(rawNumber) ? rawNumber : 0
    const abs = Math.abs(number)
    if (unit === 'ms') {
      return number.toFixed(abs >= 10 ? 0 : 1) + ' ms'
    }
    if (unit === 'percent') {
      return number.toFixed(abs >= 10 ? 0 : 1) + '%'
    }
    if (unit === 'persec') {
      return number.toFixed(abs >= 10 ? 0 : 2) + '/s'
    }
    if (unit === 'deg') {
      return number.toFixed(abs >= 10 ? 0 : 2) + ' deg'
    }
    if (unit === 'px') {
      return number.toFixed(abs >= 10 ? 0 : 1) + ' px'
    }
    if (unit === 'meters') {
      if (abs === 0) {
        return '0 mm'
      }
      if (abs < 0.1) {
        return (number * 1000).toFixed(abs < 0.01 ? 1 : 0) + ' mm'
      }
      return number.toFixed(abs >= 1 ? 2 : 3) + ' m'
    }
    return number.toFixed(abs >= 10 ? 0 : 1)
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
  const dashboard = new ReconstructionDashboard()
  dashboard.init().catch((error) => {
    console.error('[Dashboard] init failed', error)
  })
})