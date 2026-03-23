ReconstructionDashboard.prototype.renderStateTimeline = function(events) {
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
};

ReconstructionDashboard.prototype.renderLineChart = function(container, legendEl, events, series, options = {}) {
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
};

ReconstructionDashboard.prototype.buildSegments = function(events, field) {
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
};

ReconstructionDashboard.prototype.buildMetricLabel = function(label, tooltip) {
    return '<span class="metric-heading">' + this.escapeHtml(label) + (tooltip ? this.renderMetricHelp(label, tooltip) : '') + '</span>'
};

ReconstructionDashboard.prototype.renderMetricHelp = function(label, text) {
    return '<span class="metric-help" tabindex="0" aria-label="' + this.escapeHtml(label + ' help') + '"><span class="metric-help-icon">?</span><span class="metric-help-bubble">' + this.escapeHtml(text) + '</span></span>'
};
