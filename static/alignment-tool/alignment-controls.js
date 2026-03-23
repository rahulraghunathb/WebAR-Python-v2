AlignmentTool.prototype.sourceFor = function(key) {
    if (this.qKey() === key) return 'query'
    if (this.storedKey() === key) return 'local-storage'
    const helper = typeof this.helpers.getProfile === 'function' ? this.helpers.getProfile() : null
    if (helper && this.keyFor(helper, 0) === key) return 'helper'
    return 'catalog'
};

AlignmentTool.prototype.updateProfilePanel = function() {
    if (!this.profile) return
    const saved = this.loadProfileState(this.profile.key)
    this.setText('profileName', this.profile.name || '-')
    this.setText('profileKey', this.profile.key || '-')
    this.setText('profileImage', base(this.profile.targetImageUrl) || this.profile.targetImageUrl || '-')
    this.setText('profileAsset', base(this.profile.assetUrl) || this.profile.assetUrl || '-')
    this.setText('profileWidth', meters(this.profile.targetPhysicalWidthMeters))
    this.setText('profileBaseScale', meters(this.profile.baseScaleMeters))
    this.setText('profileAlignment', alignSummary(this.profile.alignment))
    this.setText(
      'profileStorage',
      !this.storageOk
        ? 'localStorage unavailable'
        : saved && saved.updatedAt
          ? 'Saved ' + new Date(saved.updatedAt).toLocaleString()
          : 'Catalog default'
    )
    this.setText(
      'profileFootnote',
      !this.storageOk
        ? 'This browser session cannot persist edits locally.'
        : this.profileSource === 'query'
          ? 'Selected from the URL query string. Changes auto-save locally if storage is available.'
          : this.profileSource === 'local-storage'
            ? 'Restored from localStorage and ready for further alignment edits.'
            : this.profileSource === 'helper'
              ? 'Selected from the runtime helper catalog.'
              : 'Using the catalog default profile.'
    )
    this.setBadge(
      !this.storageOk
        ? 'No storage'
        : this.profileSource === 'local-storage'
          ? 'Restored'
          : this.profileSource === 'query'
            ? 'Query-selected'
            : saved && saved.alignment
              ? 'Saved'
              : 'Auto-save on'
    )
    this.setPreview(this.profile.thumbnailUrl || this.profile.targetImageUrl || '')
};
