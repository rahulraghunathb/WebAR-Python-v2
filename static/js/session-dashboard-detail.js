ReconstructionDashboard.prototype.renderDetail = function(summary, events) {
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
};

ReconstructionDashboard.prototype.renderEventTable = function(events) {
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
};
