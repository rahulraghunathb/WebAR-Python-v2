ReconstructionDashboard.prototype.statusClass = function(session) {
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
};

ReconstructionDashboard.prototype.statusLabel = function(session) {
    if (session.active) {
      return 'Live'
    }
    if (session.lastTargetState && session.lastTargetState !== '-') {
      return session.lastTargetState
    }
    return session.lastKind || 'Idle'
};

ReconstructionDashboard.prototype.colorForState = function(value) {
    return STATE_COLORS[value] || '#7d8790'
};

ReconstructionDashboard.prototype.shortenSessionId = function(value) {
    if (!value || value.length <= 26) {
      return value || '-'
    }
    return value.slice(0, 20) + '...' + value.slice(-4)
};

ReconstructionDashboard.prototype.formatDateTime = function(isoValue) {
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
};

ReconstructionDashboard.prototype.formatDuration = function(value) {
    const ms = Number(value || 0)
    if (ms >= 60000) {
      return (ms / 60000).toFixed(1) + 'm'
    }
    if (ms >= 1000) {
      return (ms / 1000).toFixed(1) + 's'
    }
    return Math.round(ms) + 'ms'
};

ReconstructionDashboard.prototype.formatPercent = function(value) {
    return Math.round(Number(value || 0) * 100) + '%'
};

ReconstructionDashboard.prototype.formatNumber = function(value, digits) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? number.toFixed(digits) : Number(0).toFixed(digits)
};

ReconstructionDashboard.prototype.formatChartValue = function(value, unit) {
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
};

ReconstructionDashboard.prototype.escapeHtml = function(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
};
